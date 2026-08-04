import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import test from "node:test";

import { Miniflare } from "miniflare";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const totp = (secret) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret].map((character) => alphabet.indexOf(character).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from((bits.match(/.{8}/g) || []).map((chunk) => Number.parseInt(chunk, 2)));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hash = createHmac("sha1", key).update(message).digest();
  const offset = hash.at(-1) & 15;
  const value = ((hash[offset] & 127) << 24) | (hash[offset + 1] << 16)
    | (hash[offset + 2] << 8) | hash[offset + 3];
  return String(value % 1000000).padStart(6, "0");
};

test("management report completes the admin API round trip", async (t) => {
  const adminEmail = "admin@example.test";
  const adminPassword = "local-admin-password";
  const companyCode = "writeup";
  const adminHeaders = { "x-company-code": companyCode, "x-admin-email": adminEmail,
    "x-admin-password": adminPassword };
  const mf = new Miniflare({
    compatibilityDate: "2026-07-20",
    modules: true,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    scriptPath: "worker/index.js",
    d1Databases: { DB: "screen-capture-report-test" },
    bindings: {
      ADMIN_EMAIL: adminEmail,
      ADMIN_PASSWORD_HASH: digest(adminPassword),
      REPORT_ENCRYPTION_KEY_V1: randomBytes(32).toString("base64"),
      ALLOW_SELF_REGISTRATION: "true",
    },
  });
  t.after(() => mf.dispose());

  const fetch = (path, init = {}) => mf.dispatchFetch(`http://localhost${path}`, init);

  const anonymous = await fetch("/api/admin/summary");
  assert.equal(anonymous.status, 401);

  const adminPage = await fetch("/admin");
  assert.equal(adminPage.status, 200);
  const adminHtml = await adminPage.text();
  assert.match(adminHtml, /企業コード/);
  assert.doesNotMatch(adminHtml, /\.scr-provision\.json/);

  const wrongEmail = await fetch("/api/admin/summary", {
    headers: { ...adminHeaders, "x-admin-email": "other@example.test" },
  });
  assert.equal(wrongEmail.status, 401);

  const registration = await fetch("/api/v1/device/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-company-code": companyCode },
    body: JSON.stringify({
      displayName: "山田 花子",
      department: "開発部",
      deviceName: "YAMADA-PC",
    }),
  });
  assert.equal(registration.status, 201);
  const { deviceToken } = await registration.json();
  assert.ok(deviceToken.length >= 40);
  const heartbeat = await fetch("/api/v1/device/heartbeat", { method: "POST",
    headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
    body: JSON.stringify({ metric_date: "2026-08-04", app_version: "0.4.0",
      collection_state: "active", scheduled_count: 480, eligible_count: 450,
      captured_count: 430, failed_count: 5, missing_count: 15, analyzed_count: 425,
      analysis_failed_count: 5, pause_reasons: { locked: 20, idle: 10 }, policy_version: 0 }) });
  assert.equal(heartbeat.status, 200);
  const initialPolicy = await fetch("/api/v1/device/policy", {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(initialPolicy.status, 200);
  assert.equal((await initialPolicy.json()).version, 0);

  const renamed = await fetch("/api/v1/device/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ companyCode, companyName: "株式会社ライトアップ",
      employeeId: "employee-rename", department: "QA", deviceName: "RENAME-PC" }),
  });
  assert.equal(renamed.status, 201);
  const renamedBody = await renamed.json();

  const oversizedCompanyCode = await fetch("/api/v1/device/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ companyCode: "x".repeat(101), employeeId: "employee-x",
      department: "QA", deviceName: "TEST-PC" }),
  });
  assert.equal(oversizedCompanyCode.status, 401);

  const report = {
    schema_version: 1,
    report_id: "report-2026-07-13-yamada",
    period_start: "2026-07-13",
    period_end: "2026-07-19",
    revision: 1,
    kind: "weekly",
    audience: "management",
    finalized: true,
    generated_at: "2026-07-20T00:00:00.000Z",
    report_html: "<h1>週次管理レポート</h1><p>テスト本文</p>",
    metrics: {
      activeMinutes: 1200,
      idleMinutes: 60,
      captureCount: 40,
      workLogCount: 12,
      categories: [{ category: "development", minutes: 720 }, { category: "research", minutes: 480 }],
    },
  };
  const uploadInit = {
    method: "POST",
    headers: {
      authorization: `Bearer ${deviceToken}`,
      "content-type": "application/json",
      "idempotency-key": report.report_id,
    },
    body: JSON.stringify(report),
  };

  const uploaded = await fetch("/api/v1/device/reports/weekly-management", uploadInit);
  assert.equal(uploaded.status, 201);
  const uploadedBody = await uploaded.json();
  assert.equal(uploadedBody.reportId, report.report_id);

  const duplicate = await fetch("/api/v1/device/reports/weekly-management", uploadInit);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).reportId, report.report_id);

  const reportV2 = { ...report, revision: 2,
    generated_at: "2026-07-20T01:00:00.000Z",
    report_html: "<h1>週次管理レポート v2</h1><p>レビュー反映済み</p>" };
  const uploadedV2 = await fetch("/api/v1/device/reports/weekly-management", {
    ...uploadInit, headers: { ...uploadInit.headers, "idempotency-key": `${report.report_id}-v2` },
    body: JSON.stringify(reportV2),
  });
  assert.equal(uploadedV2.status, 200);
  const conflictingV2 = await fetch("/api/v1/device/reports/weekly-management", {
    ...uploadInit, headers: { ...uploadInit.headers, "idempotency-key": `${report.report_id}-v2-conflict` },
    body: JSON.stringify({ ...reportV2, report_html: "<p>同一版の不正な差し替え</p>" }),
  });
  assert.equal(conflictingV2.status, 409);

  const forbiddenDaily = await fetch("/api/v1/device/reports/weekly-management", {
    ...uploadInit,
    headers: { ...uploadInit.headers, "idempotency-key": "daily-report" },
    body: JSON.stringify({ ...report, report_id: "daily-report", kind: "daily", audience: "employee" }),
  });
  assert.equal(forbiddenDaily.status, 422);

  const unfinalized = await fetch("/api/v1/device/reports/weekly-management", {
    ...uploadInit,
    headers: { ...uploadInit.headers, "idempotency-key": "unfinalized-report" },
    body: JSON.stringify({ ...report, report_id: "unfinalized-report", finalized: false }),
  });
  assert.equal(unfinalized.status, 422);

  const login = await fetch("/api/auth/login", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ companyCode, email: adminEmail, password: adminPassword }) });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  const sessionCookie = login.headers.get("set-cookie").split(";")[0];
  const sessionHeaders = { cookie: sessionCookie };
  const mutationHeaders = { ...sessionHeaders, "x-csrf-token": loginBody.csrfToken };

  const summary = await fetch("/api/admin/summary", { headers: sessionHeaders });
  assert.equal(summary.status, 200);
  const dashboard = await summary.json();
  assert.equal(dashboard.company.name, "株式会社ライトアップ");
  assert.equal(dashboard.employees.length, 2);
  assert.equal(dashboard.reports.length, 1);
  assert.equal(dashboard.reports[0].display_name, "山田 花子");

  const live = await fetch("/api/dashboard/summary", { headers: sessionHeaders });
  assert.equal(live.status, 200);
  const liveDashboard = await live.json();
  assert.equal(liveDashboard.employeeCount, 2);
  assert.equal(liveDashboard.employees.length, 2);
  renamedBody.employeeId = liveDashboard.employees.find((item) => item.department === "QA").id;
  assert.deepEqual(
    liveDashboard.employees.map((item) => item.department).sort(),
    ["QA", "開発部"],
  );
  assert.equal(liveDashboard.reportCount, 1);
  assert.equal(liveDashboard.deviceHeartbeats[0].captured_count, 430);
  assert.equal(liveDashboard.deviceHeartbeats[0].pause_reasons.locked, 20);
  assert.deepEqual(liveDashboard.rows.map((item) => item.minutes), [720, 480]);
  assert.equal(liveDashboard.reports[0].revision, 2);
  assert.deepEqual(liveDashboard.reports[0].versions.map((item) => item.revision), [2, 1]);

  const content = await fetch(`/api/admin/reports/${report.report_id}/content`, {
    headers: sessionHeaders,
  });
  assert.equal(content.status, 200);
  const decrypted = await content.json();
  assert.equal(decrypted.html, reportV2.report_html);
  assert.equal(decrypted.sha256, digest(reportV2.report_html));
  const firstVersion = await fetch(`/api/admin/reports/${report.report_id}/versions/1/content`, {
    headers: sessionHeaders,
  });
  assert.equal(firstVersion.status, 200);
  assert.equal((await firstVersion.json()).html, report.report_html);

  const workflowToReview = await fetch(`/api/admin/reports/${report.report_id}/workflow`, {
    method: "PATCH", headers: { ...mutationHeaders, "content-type": "application/json" },
    body: JSON.stringify({ status: "review_pending", note: "再確認" }),
  });
  assert.equal(workflowToReview.status, 200);
  const invalidWorkflow = await fetch(`/api/admin/reports/${report.report_id}/workflow`, {
    method: "PATCH", headers: { ...mutationHeaders, "content-type": "application/json" },
    body: JSON.stringify({ status: "delivered" }),
  });
  assert.equal(invalidWorkflow.status, 409);
  assert.equal((await fetch(`/api/admin/reports/${report.report_id}/workflow`, {
    method: "PATCH", headers: { ...mutationHeaders, "content-type": "application/json" },
    body: JSON.stringify({ status: "finalized" }),
  })).status, 200);

  assert.equal((await fetch("/api/admin/opportunities/state", { method: "POST",
    headers: { ...mutationHeaders, "content-type": "application/json" },
    body: JSON.stringify({ department: "開発部", category: "development", status: "reviewing",
      owner: "技術責任者", nextAction: "PoC計画を作成" }) })).status, 200);
  assert.equal((await fetch("/api/admin/classification-rules", { method: "PUT",
    headers: { ...mutationHeaders, "content-type": "application/json" },
    body: JSON.stringify({ category: "development", displayName: "開発・レビュー",
      automationRate: 0.45, status: "active" }) })).status, 200);
  const privacyCreated = await fetch("/api/admin/privacy-requests", { method: "POST",
    headers: { ...mutationHeaders, "content-type": "application/json" },
    body: JSON.stringify({ requestType: "export", subject: "山田 花子", reason: "本人確認" }) });
  assert.equal(privacyCreated.status, 201);
  const privacyId = (await privacyCreated.json()).id;
  assert.equal((await fetch(`/api/admin/privacy-requests/${privacyId}`, { method: "PATCH",
    headers: { ...mutationHeaders, "content-type": "application/json" },
    body: JSON.stringify({ status: "processing" }) })).status, 200);
  assert.equal((await fetch("/api/admin/consent-events", { method: "POST",
    headers: { ...mutationHeaders, "content-type": "application/json" },
    body: JSON.stringify({ employeeId: liveDashboard.employees[0].id, status: "granted",
      source: "労務確認" }) })).status, 201);
  assert.equal((await fetch("/api/admin/collection-policy", { method: "PUT",
    headers: { ...mutationHeaders, "content-type": "application/json" },
    body: JSON.stringify({ collectionEnabled: true, excludedApps: ["1Password.exe"],
      excludedUrlPatterns: ["https://bank.example/*"], excludedTimeRanges: ["12:00-13:00"],
      purposeText: "業務改善とAI化候補の実測" }) })).status, 200);
  const updatedPolicy = await fetch("/api/v1/device/policy", {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(updatedPolicy.status, 200);
  assert.equal((await updatedPolicy.json()).version, 1);
  const phase2Summary = await fetch("/api/dashboard/summary", { headers: sessionHeaders });
  const phase2Data = await phase2Summary.json();
  assert.equal(phase2Data.opportunityStates[0].status, "reviewing");
  assert.equal(phase2Data.classificationRules[0].automation_rate, 0.45);
  assert.equal(phase2Data.privacyRequests[0].status, "processing");
  assert.equal(phase2Data.consentEvents[0].status, "granted");
  assert.equal(phase2Data.collectionPolicy.excludedApps[0], "1Password.exe");

  const correction = await fetch("/api/admin/classification-corrections", { method: "POST",
    headers: { ...mutationHeaders, "content-type": "application/json" },
    body: JSON.stringify({ reportId: report.report_id, fromCategory: "development",
      toCategory: "administration", minutes: 120, reason: "管理作業を誤って開発に分類" }) });
  assert.equal(correction.status, 201);
  const correctedSummary = await fetch("/api/dashboard/summary", { headers: sessionHeaders });
  const correctedData = await correctedSummary.json();
  assert.equal(correctedData.reports[0].reaggregationVersion, 2);
  assert.equal(correctedData.rows.find((item) => item.category === "development").minutes, 600);
  assert.equal(correctedData.rows.find((item) => item.category === "administration").minutes, 120);

  const holdCreated = await fetch("/api/admin/legal-holds", { method: "POST",
    headers: { ...mutationHeaders, "content-type": "application/json" },
    body: JSON.stringify({ targetType: "employee", targetId: renamedBody.employeeId,
      reason: "係争対応のため保持" }) });
  assert.equal(holdCreated.status, 201);
  const holdId = (await holdCreated.json()).id;
  const deletionCreated = await fetch("/api/admin/privacy-requests", { method: "POST",
    headers: { ...mutationHeaders, "content-type": "application/json" },
    body: JSON.stringify({ requestType: "deletion", targetType: "employee",
      targetId: renamedBody.employeeId, subject: "QA従業員", reason: "本人から削除依頼" }) });
  assert.equal(deletionCreated.status, 201);
  const deletionId = (await deletionCreated.json()).id;
  assert.equal((await fetch(`/api/admin/privacy-requests/${deletionId}`, { method: "PATCH",
    headers: { ...mutationHeaders, "content-type": "application/json" },
    body: JSON.stringify({ status: "processing" }) })).status, 200);
  assert.equal((await fetch(`/api/admin/privacy-requests/${deletionId}/execute-deletion`, {
    method: "POST", headers: mutationHeaders })).status, 409);
  assert.equal((await fetch(`/api/admin/legal-holds/${holdId}/release`, {
    method: "POST", headers: mutationHeaders })).status, 200);
  const executedDeletion = await fetch(`/api/admin/privacy-requests/${deletionId}/execute-deletion`, {
    method: "POST", headers: mutationHeaders });
  assert.equal(executedDeletion.status, 200);
  assert.equal((await executedDeletion.json()).employeesDeleted, 1);
  const postDeletion = await fetch("/api/dashboard/summary", { headers: sessionHeaders });
  assert.equal((await postDeletion.json()).employeeCount, 1);

  const betaRegistration = await fetch("/api/v1/device/register", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ companyCode: "company-code-beta",
      employeeId: "beta-employee", department: "営業", deviceName: "BETA-PC" }) });
  assert.equal(betaRegistration.status, 201);
  const betaLogin = await fetch("/api/auth/login", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ companyCode: "company-code-beta",
      email: adminEmail, password: adminPassword }) });
  assert.equal(betaLogin.status, 200);
  const betaLoginBody = await betaLogin.json();
  const betaHeaders = { cookie: betaLogin.headers.get("set-cookie").split(";")[0] };
  const otherBootstrap = await fetch("/api/admin/summary", { headers: betaHeaders });
  assert.equal(otherBootstrap.status, 200);
  assert.equal((await otherBootstrap.json()).reports.length, 0);
  const crossTenantContent = await fetch(`/api/admin/reports/${report.report_id}/content`, {
    headers: betaHeaders,
  });
  assert.equal(crossTenantContent.status, 404);
  assert.equal((await fetch(`/api/admin/reports/${report.report_id}/versions/1/content`, {
    headers: betaHeaders,
  })).status, 404);
  assert.equal((await fetch(`/api/admin/privacy-requests/${privacyId}`, { method: "PATCH",
    headers: { ...betaHeaders, "x-csrf-token": betaLoginBody.csrfToken,
      "content-type": "application/json" }, body: JSON.stringify({ status: "completed" }) })).status, 404);
  const betaMutationHeaders = { ...betaHeaders, "x-csrf-token": betaLoginBody.csrfToken,
    "content-type": "application/json" };
  assert.equal((await fetch("/api/admin/classification-corrections", { method: "POST",
    headers: betaMutationHeaders, body: JSON.stringify({ reportId: report.report_id,
      fromCategory: "development", toCategory: "administration", minutes: 1,
      reason: "cross tenant" }) })).status, 404);
  assert.equal((await fetch(`/api/admin/legal-holds/${holdId}/release`, { method: "POST",
    headers: betaMutationHeaders })).status, 404);
  assert.equal((await fetch(`/api/admin/privacy-requests/${deletionId}/execute-deletion`, {
    method: "POST", headers: betaMutationHeaders })).status, 404);

  const badCsrf = await fetch("/api/admin/settings", { method: "PATCH", headers: {
    ...sessionHeaders, "content-type": "application/json" }, body: JSON.stringify({ timezone: "Asia/Tokyo",
      weekStart: 1, reportRetentionDays: 90, auditRetentionDays: 365 }) });
  assert.equal(badCsrf.status, 403);
  assert.equal((await fetch("/api/admin/legal-holds", { method: "POST", headers: {
    ...sessionHeaders, "content-type": "application/json" }, body: JSON.stringify({
      targetType: "company", targetId: liveDashboard.company.id, reason: "missing csrf" }) })).status, 403);

  const settings = await fetch("/api/admin/settings", { method: "PATCH", headers: {
    ...mutationHeaders, "content-type": "application/json" }, body: JSON.stringify({ timezone: "Asia/Tokyo",
      weekStart: 1, reportRetentionDays: 120, auditRetentionDays: 400 }) });
  assert.equal(settings.status, 200);

  const managerCreated = await fetch("/api/admin/users", { method: "POST", headers: {
    ...mutationHeaders, "content-type": "application/json" }, body: JSON.stringify({
      email: "manager@example.test", role: "manager" }) });
  assert.equal(managerCreated.status, 201);
  const managerPassword = (await managerCreated.json()).temporaryPassword;
  const auditorCreated = await fetch("/api/admin/users", { method: "POST", headers: {
    ...mutationHeaders, "content-type": "application/json" }, body: JSON.stringify({
      email: "auditor@example.test", role: "auditor" }) });
  assert.equal(auditorCreated.status, 201);
  const auditorPassword = (await auditorCreated.json()).temporaryPassword;
  const managerLogin = await fetch("/api/auth/login", { method: "POST", headers: {
    "content-type": "application/json" }, body: JSON.stringify({ companyCode,
      email: "manager@example.test", password: managerPassword }) });
  assert.equal(managerLogin.status, 200);
  const managerSession = await managerLogin.json();
  const managerHeaders = { cookie: managerLogin.headers.get("set-cookie").split(";")[0],
    "x-csrf-token": managerSession.csrfToken, "content-type": "application/json" };
  assert.equal((await fetch(`/api/admin/reports/${report.report_id}/content`, {
    headers: managerHeaders })).status, 200);
  assert.equal((await fetch("/api/admin/settings", { method: "PATCH", headers: managerHeaders,
    body: JSON.stringify({ timezone: "Asia/Tokyo", weekStart: 1,
      reportRetentionDays: 90, auditRetentionDays: 365 }) })).status, 403);
  const auditorLogin = await fetch("/api/auth/login", { method: "POST", headers: {
    "content-type": "application/json" }, body: JSON.stringify({ companyCode,
      email: "auditor@example.test", password: auditorPassword }) });
  assert.equal(auditorLogin.status, 200);
  const auditorSession = await auditorLogin.json();
  const auditorHeaders = { cookie: auditorLogin.headers.get("set-cookie").split(";")[0],
    "x-csrf-token": auditorSession.csrfToken, "content-type": "application/json" };
  assert.equal((await fetch("/api/dashboard/summary", { headers: auditorHeaders })).status, 200);
  assert.equal((await fetch(`/api/admin/reports/${report.report_id}/content`, {
    headers: auditorHeaders })).status, 403);
  assert.equal((await fetch("/api/admin/opportunities/state", { method: "POST", headers: auditorHeaders,
    body: JSON.stringify({ department: "QA", category: "research", status: "reviewing" }) })).status, 403);

  const enrollment = await fetch("/api/admin/mfa/enroll", { method: "POST", headers: mutationHeaders });
  assert.equal(enrollment.status, 200);
  const mfaSecret = (await enrollment.json()).secret;
  assert.equal((await fetch("/api/admin/mfa/confirm", { method: "POST", headers: {
    ...mutationHeaders, "content-type": "application/json" }, body: JSON.stringify({
      otp: totp(mfaSecret) }) })).status, 200);

  const loggedOut = await fetch("/api/auth/logout", { method: "POST", headers: sessionHeaders });
  assert.equal(loggedOut.status, 200);
  assert.equal((await fetch("/api/dashboard/summary", { headers: sessionHeaders })).status, 401);
  assert.equal((await fetch("/api/auth/login", { method: "POST", headers: {
    "content-type": "application/json" }, body: JSON.stringify({ companyCode,
      email: adminEmail, password: adminPassword }) })).status, 401);
  assert.equal((await fetch("/api/auth/login", { method: "POST", headers: {
    "content-type": "application/json" }, body: JSON.stringify({ companyCode,
      email: adminEmail, password: adminPassword, otp: totp(mfaSecret) }) })).status, 200);

  const failedStatuses = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    failedStatuses.push((await fetch("/api/auth/login", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ companyCode,
        email: "rate-limit@example.test", password: "wrong-password" }) })).status);
  }
  assert.deepEqual(failedStatuses, [401, 401, 401, 401, 401, 429]);
});

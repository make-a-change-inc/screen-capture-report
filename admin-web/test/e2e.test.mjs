import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import { Miniflare } from "miniflare";

const digest = (value) => createHash("sha256").update(value).digest("hex");

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

  const renamed = await fetch("/api/v1/device/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ companyCode, companyName: "株式会社ライトアップ",
      employeeId: "employee-rename", department: "QA", deviceName: "RENAME-PC" }),
  });
  assert.equal(renamed.status, 201);

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

  const summary = await fetch("/api/admin/summary", {
    headers: adminHeaders,
  });
  assert.equal(summary.status, 200);
  const dashboard = await summary.json();
  assert.equal(dashboard.company.name, "株式会社ライトアップ");
  assert.equal(dashboard.employees.length, 2);
  assert.equal(dashboard.reports.length, 1);
  assert.equal(dashboard.reports[0].display_name, "山田 花子");

  const live = await fetch("/api/dashboard/summary", { headers: adminHeaders });
  assert.equal(live.status, 200);
  const liveDashboard = await live.json();
  assert.equal(liveDashboard.employeeCount, 2);
  assert.equal(liveDashboard.employees.length, 2);
  assert.deepEqual(
    liveDashboard.employees.map((item) => item.department).sort(),
    ["QA", "開発部"],
  );
  assert.equal(liveDashboard.reportCount, 1);
  assert.deepEqual(liveDashboard.rows.map((item) => item.minutes), [720, 480]);

  const content = await fetch(`/api/admin/reports/${report.report_id}/content`, {
    headers: adminHeaders,
  });
  assert.equal(content.status, 200);
  const decrypted = await content.json();
  assert.equal(decrypted.html, report.report_html);
  assert.equal(decrypted.sha256, digest(report.report_html));

  const otherHeaders = { ...adminHeaders, "x-company-code": "company-code-beta" };
  const otherBootstrap = await fetch("/api/admin/summary", { headers: otherHeaders });
  assert.equal(otherBootstrap.status, 200);
  assert.equal((await otherBootstrap.json()).reports.length, 0);
  const crossTenantContent = await fetch(`/api/admin/reports/${report.report_id}/content`, {
    headers: otherHeaders,
  });
  assert.equal(crossTenantContent.status, 404);
});

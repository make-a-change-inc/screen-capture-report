import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import { Miniflare } from "miniflare";

const digest = (value) => createHash("sha256").update(value).digest("hex");

test("management report completes the admin API round trip", async (t) => {
  const adminEmail = "admin@example.test";
  const adminPassword = "local-admin-password";
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

  const wrongEmail = await fetch("/api/admin/summary", {
    headers: { "x-admin-email": "other@example.test", "x-admin-password": adminPassword },
  });
  assert.equal(wrongEmail.status, 401);

  const registration = await fetch("/api/admin/devices", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-email": adminEmail, "x-admin-password": adminPassword },
    body: JSON.stringify({
      displayName: "山田 花子",
      department: "開発部",
      deviceName: "YAMADA-PC",
    }),
  });
  assert.equal(registration.status, 201);
  const { deviceToken } = await registration.json();
  assert.ok(deviceToken.length >= 40);

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
    headers: { "x-admin-email": adminEmail, "x-admin-password": adminPassword },
  });
  assert.equal(summary.status, 200);
  const dashboard = await summary.json();
  assert.equal(dashboard.employees.length, 1);
  assert.equal(dashboard.reports.length, 1);
  assert.equal(dashboard.reports[0].display_name, "山田 花子");

  const live = await fetch("/api/dashboard/summary");
  assert.equal(live.status, 200);
  const liveDashboard = await live.json();
  assert.equal(liveDashboard.employeeCount, 1);
  assert.equal(liveDashboard.reportCount, 1);
  assert.deepEqual(liveDashboard.rows.map((item) => item.minutes), [720, 480]);

  const content = await fetch(`/api/admin/reports/${report.report_id}/content`, {
    headers: { "x-admin-email": adminEmail, "x-admin-password": adminPassword },
  });
  assert.equal(content.status, 200);
  const decrypted = await content.json();
  assert.equal(decrypted.html, report.report_html);
  assert.equal(decrypted.sha256, digest(report.report_html));
});

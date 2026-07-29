import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import { Miniflare } from "miniflare";

const digest = (value) => createHash("sha256").update(value).digest("hex");

test("invitation enrollment accepts only final weekly aggregate reports", async (t) => {
  const adminEmail = "admin@example.test";
  const adminPassword = "local-admin-password";
  const mf = new Miniflare({
    compatibilityDate: "2026-07-20", modules: true,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }], scriptPath: "worker/index.js",
    d1Databases: { DB: "screen-capture-report-test" },
    bindings: { ADMIN_EMAIL: adminEmail, ADMIN_PASSWORD_HASH: digest(adminPassword), REPORT_ENCRYPTION_KEY_V1: randomBytes(32).toString("base64") },
  });
  t.after(() => mf.dispose());
  const fetch = (path, init = {}) => mf.dispatchFetch(`http://localhost${path}`, init);
  const adminHeaders = { "x-admin-email": adminEmail, "x-admin-password": adminPassword };

  assert.equal((await fetch("/api/admin/dashboard")).status, 401);
  const invitation = await fetch("/api/admin/invitation/rotate", { method: "POST", headers: adminHeaders });
  assert.equal(invitation.status, 201);
  const { invitationCode } = await invitation.json();
  assert.ok(invitationCode.startsWith("SCR-"));
  const replacementInvitation = await fetch("/api/admin/invitation/rotate", { method: "POST", headers: adminHeaders });
  const { invitationCode: activeInvitationCode } = await replacementInvitation.json();
  assert.notEqual(activeInvitationCode, invitationCode);
  assert.equal((await fetch("/api/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ inviteCode: invitationCode, displayName: "山田 花子", employeeId: "employee-1", department: "開発部" }) })).status, 401);
  assert.equal((await fetch("/api/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ inviteCode: "wrong", displayName: "山田 花子", employeeId: "employee-1", department: "開発部" }) })).status, 401);

  const enrolled = await fetch("/api/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ inviteCode: activeInvitationCode, displayName: "山田 花子", employeeId: "employee-1", department: "開発部" }) });
  assert.equal(enrolled.status, 201);
  const { deviceToken } = await enrolled.json();
  const report = { schema_version: 1, report_id: "report-2026-07-13-yamada", period_start: "2026-07-13", period_end: "2026-07-19", revision: 1, kind: "weekly", audience: "management", finalized: true, generated_at: "2026-07-20T00:00:00.000Z", report_html: "<h1>週次管理レポート</h1>", metrics: { activeMinutes: 1200, categories: [{ category: "development", minutes: 720 }] } };
  const upload = { method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json", "idempotency-key": report.report_id }, body: JSON.stringify(report) };
  assert.equal((await fetch("/api/v1/device/reports/weekly-management", upload)).status, 201);
  assert.equal((await fetch("/api/v1/device/reports/weekly-management", { ...upload, headers: { ...upload.headers, "idempotency-key": "daily" }, body: JSON.stringify({ ...report, report_id: "daily", kind: "daily", audience: "employee" }) })).status, 422);

  const users = await fetch("/api/admin/users?department=%E9%96%8B%E7%99%BA%E9%83%A8", { headers: adminHeaders });
  const usersBody = await users.json();
  assert.deepEqual(usersBody.users, [{ employeeId: "employee-1", displayName: "山田 花子", department: "開発部" }]);
  const dashboard = await fetch("/api/admin/dashboard", { headers: adminHeaders });
  const dashboardBody = await dashboard.json();
  assert.deepEqual(dashboardBody.rows, [{ periodStart: "2026-07-13", periodEnd: "2026-07-19", department: "開発部", category: "development", minutes: 720, employeeCount: 1 }]);
  assert.doesNotMatch(JSON.stringify(dashboardBody), /employee-1/);

  const reenrolled = await fetch("/api/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ inviteCode: activeInvitationCode, displayName: "山田 花子", employeeId: "employee-1", department: "開発部" }) });
  const { deviceToken: replacementToken } = await reenrolled.json();
  assert.notEqual(replacementToken, deviceToken);
  assert.equal((await fetch("/api/v1/device/reports/weekly-management", upload)).status, 401);
});

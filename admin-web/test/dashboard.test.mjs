import assert from "node:assert/strict";
import test from "node:test";

import { dashboardPage } from "../worker/dashboard-page.js";

test("management UI exposes only the implemented navigation", () => {
  assert.match(dashboardPage, />AI化提案<\/button>/);
  assert.match(dashboardPage, />利用状況<\/button>/);
  assert.match(dashboardPage, />設定<\/button>/);
  assert.doesNotMatch(dashboardPage, />業務ダッシュボード<\/button>/);
  assert.doesNotMatch(dashboardPage, />運用状況<\/button>/);
});

test("AI proposal page uses the authenticated aggregate endpoint and three summary metrics", () => {
  assert.match(dashboardPage, /api\('\/api\/admin\/dashboard'/);
  assert.match(dashboardPage, /対象業務の実測時間/);
  assert.match(dashboardPage, /AI化した場合の削減見込み/);
  assert.match(dashboardPage, /今回の集計対象社員数/);
  assert.doesNotMatch(dashboardPage, /同期済みレポート/);
  assert.doesNotMatch(dashboardPage, /employeeId: report\.employee_id/);
});

test("user and settings pages do not show individual work details", () => {
  assert.match(dashboardPage, /氏名<\/th><th>社員ID<\/th><th>所属部署/);
  assert.match(dashboardPage, /api\/admin\/invitation/);
  assert.match(dashboardPage, /class="menu">メニュー/);
  assert.doesNotMatch(dashboardPage, /ウィンドウタイトルは送信/);
});

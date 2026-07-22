import assert from "node:assert/strict";
import test from "node:test";

import { dashboardPage } from "../worker/dashboard-page.js";

test("dashboard loads live D1 data instead of embedded mock totals", () => {
  assert.match(dashboardPage, /fetch\('\/api\/dashboard\/summary'/);
  assert.match(dashboardPage, /Cloudflare D1 実データ/);
  assert.match(dashboardPage, /実測業務データ/);
  assert.doesNotMatch(dashboardPage, /134\.3/);
  assert.doesNotMatch(dashboardPage, /169\.3/);
  assert.doesNotMatch(dashboardPage, /data-scenario=/);
});

test("dashboard separates measured time from estimated savings", () => {
  assert.match(dashboardPage, /「実測時間」は端末で分類された業務ログの合計/);
  assert.match(dashboardPage, /「削減予想」はカテゴリ別の適用率を使った試算/);
  assert.match(dashboardPage, /個人単位の情報は表示していません/);
});

test("weekly report UI remains off", () => {
  assert.doesNotMatch(dashboardPage, /data-report=/);
  assert.doesNotMatch(dashboardPage, /reportModal/);
  assert.doesNotMatch(dashboardPage, />レポート<\/button>/);
});

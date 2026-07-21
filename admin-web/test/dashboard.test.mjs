import assert from "node:assert/strict";
import test from "node:test";

import { dashboardPage } from "../worker/dashboard-page.js";

test("integrated transformation dashboard has consistent demo totals", () => {
  assert.match(dashboardPage, /この作業を、<span>このAIで<\/span>、こう変える。/);
  assert.match(dashboardPage, /−134\.3<span>h \/ 月<\/span>/);
  assert.match(dashboardPage, /現状169\.3時間 → 導入後35\.0時間/);
  assert.match(dashboardPage, /数値は<b>すべてデモ用想定値<\/b>/);

  const scenarioButtons = dashboardPage.match(/data-scenario="\d+"/g) || [];
  assert.equal(scenarioButtons.length, 10);
  assert.doesNotMatch(dashboardPage, /137\.3h/);
  assert.doesNotMatch(dashboardPage, /42名/);
});

test("weekly report UI is off while privacy boundaries remain visible", () => {
  assert.doesNotMatch(dashboardPage, /data-report=/);
  assert.doesNotMatch(dashboardPage, /reportModal/);
  assert.doesNotMatch(dashboardPage, /週次レポートを確認/);
  assert.doesNotMatch(dashboardPage, />レポート<\/button>/);
  assert.match(dashboardPage, /生画像・ウィンドウタイトル・個人ランキングは管理画面に表示しません/);
  assert.doesNotMatch(dashboardPage, /<img[^>]+スクリーンショット/);
});

test("scenario arithmetic reconciles", () => {
  const before = [26, 22.5, 18, 16.8, 20, 14, 12.5, 15.5, 11, 13];
  const after = [2, 6, 2, 4, 3, 5, 3.5, 4.5, 2, 3];
  const saving = [24, 16.5, 16, 12.8, 17, 9, 9, 11, 9, 10];

  assert.equal(before.reduce((sum, value) => sum + value, 0), 169.3);
  assert.equal(after.reduce((sum, value) => sum + value, 0), 35);
  assert.equal(saving.reduce((sum, value) => sum + value, 0), 134.3);
});

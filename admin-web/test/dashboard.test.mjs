import assert from "node:assert/strict";
import test from "node:test";

import { dashboardPage } from "../worker/dashboard-page.js";
import { authenticatedDashboardPage } from "../worker/authenticated-dashboard-page.js";

test("dashboard uses server-side cookie sessions without browser password storage", () => {
  assert.match(authenticatedDashboardPage, /\/api\/auth\/login/);
  assert.match(authenticatedDashboardPage, /\/api\/auth\/session/);
  assert.match(authenticatedDashboardPage, /\/api\/auth\/logout/);
  assert.match(authenticatedDashboardPage, /credentials:'same-origin'/);
  assert.doesNotMatch(authenticatedDashboardPage, /sessionStorage|localStorage|x-admin-password/);
});

test("dashboard exposes real Japanese navigation pages", () => {
  for (const label of ["経営ダッシュボード", "業務分析", "AI化候補", "レポート", "従業員管理",
    "端末・収集状況", "分類ルール・データ品質", "プライバシー・データ管理", "ユーザー・権限",
    "監査ログ", "組織設定"]) assert.match(dashboardPage, new RegExp(label));
  assert.match(dashboardPage, /data-page="reports"/);
  assert.match(dashboardPage, /data-page="employees"/);
  assert.doesNotMatch(dashboardPage, /OVERVIEW|GOVERNANCE|Employee management/);
});

test("employees remain read-only and reports have accessible detail controls", () => {
  assert.match(dashboardPage, /従業員一覧（読み取り専用）/);
  assert.match(dashboardPage, /作成・編集・削除は行いません/);
  assert.doesNotMatch(dashboardPage, /従業員を作成|従業員を編集|従業員を削除/);
  assert.match(dashboardPage, /data-report=/);
  assert.match(dashboardPage, /詳細・版履歴/);
  assert.match(dashboardPage, /sandbox=""/);
});

test("unclear categories are localized and excluded from AI proposals", () => {
  assert.match(dashboardPage, /other:'その他（要分類）'/);
  assert.match(dashboardPage, /administration:'管理・事務'/);
  assert.match(dashboardPage, /development:'開発'/);
  assert.match(dashboardPage, /filter\(x=>!unclear\(x\.category\)\)/);
  assert.match(dashboardPage, /自動化率は分類ルールで管理する試算係数/);
  assert.match(dashboardPage, /「その他」「未分類」はAI化候補から除外/);
});

test("phase 2 management workflows are exposed in the dashboard", () => {
  assert.match(dashboardPage, /レビュー状態・担当者・次のアクションを管理/);
  assert.match(dashboardPage, /data-report-status/);
  assert.match(dashboardPage, /classificationForm/);
  assert.match(dashboardPage, /privacyRequestForm/);
  assert.match(dashboardPage, /consentForm/);
  assert.match(dashboardPage, /\/api\/admin\/reports\//);
  assert.match(dashboardPage, /\/workflow/);
  assert.match(dashboardPage, /\/api\/admin\/opportunities\/state/);
  assert.match(dashboardPage, /\/api\/admin\/classification-rules/);
  assert.match(dashboardPage, /\/api\/admin\/privacy-requests/);
  assert.match(dashboardPage, /\/api\/admin\/consent-events/);
});

test("dashboard loads live D1 data and handles incomplete states", () => {
  assert.match(dashboardPage, /api\('\/api\/dashboard\/summary'/);
  assert.match(dashboardPage, /aria-busy/);
  assert.match(dashboardPage, /検索条件に一致/);
  assert.match(dashboardPage, /データを取得できませんでした/);
  assert.match(dashboardPage, /取得予定数・分析成功率・停止理由は現行端末データに含まれない/);
  assert.doesNotMatch(dashboardPage, /134\.3|169\.3/);
});

test("dashboard is responsive and keyboard-oriented", () => {
  assert.match(dashboardPage, /aria-current/);
  assert.match(dashboardPage, /aria-live="polite"/);
  assert.match(dashboardPage, /scope="col"/);
  assert.match(dashboardPage, /mobile-menu/);
  assert.match(dashboardPage, /focus-visible/);
});

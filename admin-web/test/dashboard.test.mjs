import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("worker source does not retain the retired browser-password implementation", () => {
  const workerSource = readFileSync(new URL("../worker/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(workerSource, /legacyPage|scr-admin-password|x-admin-password/);
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

test("classification correction and deletion governance are exposed", () => {
  assert.match(dashboardPage, /classificationCorrectionForm/);
  assert.match(dashboardPage, /targetedDeletionForm/);
  assert.match(dashboardPage, /legalHoldForm/);
  assert.match(dashboardPage, /deletionReceiptTable/);
  assert.match(dashboardPage, /\/api\/admin\/classification-corrections/);
  assert.match(dashboardPage, /\/api\/admin\/legal-holds/);
  assert.match(dashboardPage, /execute-deletion/);
  assert.match(dashboardPage, /window\.confirm/);
});

test("multiple administrators, RBAC, MFA, and session controls are exposed", () => {
  assert.match(dashboardPage, /adminUserForm/);
  assert.match(dashboardPage, /mfaEnroll/);
  assert.match(dashboardPage, /adminOtp/);
  assert.match(dashboardPage, /\/api\/admin\/users/);
  assert.match(dashboardPage, /revoke-sessions/);
  assert.match(dashboardPage, /\/api\/admin\/mfa\/enroll/);
  assert.match(dashboardPage, /\/api\/admin\/mfa\/confirm/);
  assert.match(dashboardPage, /Owner/);
  assert.match(dashboardPage, /Manager/);
  assert.match(dashboardPage, /Auditor/);
});

test("report PDF and delivery controls expose honest integration state", () => {
  assert.match(dashboardPage, /deliveryChannelForm/);
  assert.match(dashboardPage, /deliveryScheduleForm/);
  assert.match(dashboardPage, /deliveryHistory/);
  assert.match(dashboardPage, /pdf-audit/);
  assert.match(dashboardPage, /\/deliver/);
  assert.match(dashboardPage, /email_service_not_configured/);
  assert.match(dashboardPage, /Cloudflare側未接続/);
});

test("tenant export, tenant deletion, and password rotation are exposed", () => {
  assert.match(dashboardPage, /passwordForm/);
  assert.match(dashboardPage, /\/api\/admin\/password/);
  assert.match(dashboardPage, /tenantExport/);
  assert.match(dashboardPage, /\/api\/admin\/tenant-export/);
  assert.match(dashboardPage, /tenantDeleteRequest/);
  assert.match(dashboardPage, /targetType:'company'/);
});

test("OIDC SSO configuration and login controls are exposed", () => {
  assert.match(dashboardPage, /ssoLogin/);
  assert.match(dashboardPage, /oidcForm/);
  assert.match(dashboardPage, /\/api\/auth\/oidc\/start/);
  assert.match(dashboardPage, /\/api\/admin\/oidc-config/);
  assert.match(dashboardPage, /allowedDomain/);
  assert.match(dashboardPage, /defaultRole/);
});

test("dashboard loads live D1 data and handles incomplete states", () => {
  assert.match(dashboardPage, /api\('\/api\/dashboard\/summary'/);
  assert.match(dashboardPage, /aria-busy/);
  assert.match(dashboardPage, /検索条件に一致/);
  assert.match(dashboardPage, /データを取得できませんでした/);
  assert.match(dashboardPage, /匿名運用集計はまだ届いていません/);
  assert.match(dashboardPage, /生画像、ウィンドウタイトル、URL、詳細作業ログは送信しません/);
  assert.doesNotMatch(dashboardPage, /134\.3|169\.3/);
});

test("dashboard is responsive and keyboard-oriented", () => {
  assert.match(dashboardPage, /aria-current/);
  assert.match(dashboardPage, /aria-live="polite"/);
  assert.match(dashboardPage, /scope="col"/);
  assert.match(dashboardPage, /mobile-menu/);
  assert.match(dashboardPage, /focus-visible/);
});

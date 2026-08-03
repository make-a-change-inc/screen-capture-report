import assert from "node:assert/strict";
import test from "node:test";

import { dashboardPage } from "../worker/dashboard-page.js";
import { authenticatedDashboardPage } from "../worker/authenticated-dashboard-page.js";

test("deployed dashboard keeps company-scoped admin authentication", () => {
  assert.match(authenticatedDashboardPage, /id="loginForm"/);
  assert.match(authenticatedDashboardPage, /'x-company-code':auth\.code/);
  assert.match(authenticatedDashboardPage, /source\.company\?\.name/);
  assert.doesNotMatch(authenticatedDashboardPage, /onclick=load;load\(\)/);
});

test("invalid credentials stay on login and logout clears the session", () => {
  assert.match(authenticatedDashboardPage, /throw error}finally/);
  assert.match(authenticatedDashboardPage, /id="logout"/);
  assert.match(authenticatedDashboardPage, /sessionStorage\.removeItem\(key\)/);
  assert.match(authenticatedDashboardPage, /企業コード、管理者ID、またはパスワードが正しくありません/);
  assert.match(authenticatedDashboardPage, /q\('#login'\)\.style\.display='grid'/);
});

test("dashboard loads live D1 data instead of embedded mock totals", () => {
  assert.match(dashboardPage, /fetch\('\/api\/dashboard\/summary'/);
  assert.doesNotMatch(dashboardPage, /Cloudflare D1/);
  assert.match(dashboardPage, /実測データから、/);
  assert.doesNotMatch(dashboardPage, /134\.3/);
  assert.doesNotMatch(dashboardPage, /169\.3/);
  assert.doesNotMatch(dashboardPage, /data-scenario=/);
});

test("dashboard proposes the top three opportunities by estimated time savings", () => {
  assert.match(dashboardPage, /AI化候補 TOP 3/);
  assert.match(dashboardPage, /／週・人/);
  assert.match(dashboardPage, /employeeIds/);
  assert.match(dashboardPage, /sort\(\(a,b\)=>b\.saving-a\.saving\)\.slice\(0,3\)/);
  assert.match(dashboardPage, /削減見込み時間は、端末で分類された実測業務時間にカテゴリ別の暫定試算係数を掛けた目安/);
  assert.match(dashboardPage, /週次レポートを集計中/);
  assert.match(dashboardPage, /個人単位の情報は表示していません/);
});

test("dashboard counts employees within the selected week and department", () => {
  assert.match(dashboardPage, /scopedEmployeeIds/);
  assert.match(dashboardPage, /q\('#employeeCount'\)\.textContent=scopedEmployeeIds\.size/);
  assert.doesNotMatch(dashboardPage, /q\('#employeeCount'\)\.textContent=source\.employeeCount/);
});

test("weekly report UI remains off", () => {
  assert.doesNotMatch(dashboardPage, /data-report=/);
  assert.doesNotMatch(dashboardPage, /reportModal/);
  assert.doesNotMatch(dashboardPage, />レポート<\/button>/);
});

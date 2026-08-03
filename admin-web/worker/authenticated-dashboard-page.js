import { dashboardPage } from "./dashboard-page.js";

const login = `<div id="login" class="admin-login"><form id="loginForm" class="admin-login-card">
<div class="eyebrow">Owner access</div><h2>管理画面ログイン</h2>
<p>企業コード、管理者ID、パスワードを入力してください。</p>
<input id="companyCode" autocomplete="organization" placeholder="企業コード" maxlength="100" required>
<input id="adminEmail" type="email" autocomplete="username" placeholder="管理者ID（メールアドレス）" required>
<input id="adminPassword" type="password" autocomplete="current-password" placeholder="パスワード" required>
<button type="submit">ログイン</button><p id="loginError" class="admin-login-error"></p>
</form></div>`;

const loginStyles = `.admin-login{position:fixed;inset:0;display:grid;place-items:center;background:#10131a;z-index:10}.admin-login-card{width:min(420px,92vw);background:#fff;border-radius:16px;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.35)}.admin-login-card h2{margin:8px 0}.admin-login-card p{color:#697083}.admin-login-card input{display:block;width:100%;padding:11px;margin:8px 0;border:1px solid #dfe2e8;border-radius:7px}.admin-login-card button{width:100%;margin-top:4px;background:#2459ad;color:#fff;border:0;border-radius:7px;padding:11px;font-weight:700}.admin-login-error{color:#a23!important}`;

const authScript = `
q('#loginForm').onsubmit=async event=>{event.preventDefault();auth={code:q('#companyCode').value.trim(),email:q('#adminEmail').value.trim(),password:q('#adminPassword').value};try{await load();sessionStorage.setItem('scr-company-code',auth.code);sessionStorage.setItem('scr-admin-email',auth.email);sessionStorage.setItem('scr-admin-password',auth.password);q('#login').style.display='none'}catch{q('#loginError').textContent='企業コード、ID、またはパスワードが正しくありません'}};
if(auth.code&&auth.email&&auth.password)load().then(()=>q('#login').style.display='none').catch(()=>{});`;

export const authenticatedDashboardPage = dashboardPage
  .replace("</style></head><body>", `${loginStyles}</style></head><body>${login}`)
  .replace(
    "const q=s=>document.querySelector(s);let source=null;",
    "const q=s=>document.querySelector(s);let source=null;let auth={code:sessionStorage.getItem('scr-company-code')||'',email:sessionStorage.getItem('scr-admin-email')||'',password:sessionStorage.getItem('scr-admin-password')||''};",
  )
  .replace(
    "fetch('/api/dashboard/summary',{cache:'no-store'})",
    "fetch('/api/dashboard/summary',{cache:'no-store',headers:{'x-company-code':auth.code,'x-admin-email':auth.email,'x-admin-password':auth.password}})",
  )
  .replace(
    "source=await response.json();const periodOptions=",
    "source=await response.json();if(source.company?.name)q('.company').textContent=source.company.name;const periodOptions=",
  )
  .replace("q('#refresh').onclick=load;load();", `q('#refresh').onclick=load;${authScript}`);

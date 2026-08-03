import { dashboardPage } from "./dashboard-page.js";

const login = `<div id="login" class="admin-login"><form id="loginForm" class="admin-login-card">
<div class="eyebrow">Owner access</div><h2>管理画面ログイン</h2>
<p>企業コード、管理者ID、パスワードを入力してください。</p>
<input id="companyCode" autocomplete="organization" placeholder="企業コード" maxlength="100" required>
<input id="adminEmail" type="email" autocomplete="username" placeholder="管理者ID（メールアドレス）" required>
<input id="adminPassword" type="password" autocomplete="current-password" placeholder="パスワード" required>
<button type="submit">ログイン</button><p id="loginError" class="admin-login-error"></p>
</form></div>`;

const loginStyles = `.admin-login{position:fixed;inset:0;display:grid;place-items:center;background:#10131a;z-index:10}.admin-login-card{width:min(420px,92vw);background:#fff;border-radius:16px;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.35)}.admin-login-card h2{margin:8px 0}.admin-login-card p{color:#697083}.admin-login-card input{display:block;width:100%;padding:11px;margin:8px 0;border:1px solid #dfe2e8;border-radius:7px}.admin-login-card button{width:100%;margin-top:4px;background:#2459ad;color:#fff;border:0;border-radius:7px;padding:11px;font-weight:700}.admin-login-error{color:#a23!important}.topbar-actions{display:flex;align-items:center;gap:14px}.logout{border:1px solid #dfe2e8;background:#fff;color:#16181d;border-radius:7px;padding:7px 11px;cursor:pointer}.employee-page{display:none;padding:31px clamp(18px,4vw,52px) 64px}.employee-page h1{margin-bottom:4px}.employee-page .page-description{color:#697083;margin:0 0 22px}.employee-panel{background:#fff;border:1px solid #dfe2e8;border-radius:14px;padding:25px;box-shadow:0 8px 28px rgba(22,28,53,.04);overflow:auto}.employee-table{width:100%;border-collapse:collapse;min-width:620px}.employee-table th,.employee-table td{text-align:left;padding:13px 12px;border-bottom:1px solid #dfe2e8}.employee-table th{color:#697083;font-size:11px}.employee-table td:first-child{font-weight:700}.employee-status{color:#0f7b59;font-weight:700;font-size:12px}`;

const categoryScript = `
const categoryLabels={other:'その他',administration:'管理・事務',development:'開発',research:'調査・リサーチ',chat_meeting:'チャット・会議',meeting:'会議',documents:'資料作成',document:'資料作成',email:'メール',input:'データ入力',data_entry:'データ入力',marketing:'マーケティング',sns:'SNS・マーケティング',accounting:'経理',account:'経理'};
function categoryLabel(value){return categoryLabels[String(value||'').toLowerCase()]||String(value||'未分類')}`;

const authScript = `
function clearAuth(){for(const key of ['scr-company-code','scr-admin-email','scr-admin-password'])sessionStorage.removeItem(key);auth={code:'',email:'',password:''}}
function showPage(name){const employees=name==='employees';q('#main').style.display=employees?'none':'block';q('#employeePage').style.display=employees?'block':'none';q('#overviewMenu').classList.toggle('active',!employees);q('#employeeManagement').classList.toggle('active',employees)}
q('#loginForm').onsubmit=async event=>{event.preventDefault();q('#loginError').textContent='';auth={code:q('#companyCode').value.trim(),email:q('#adminEmail').value.trim(),password:q('#adminPassword').value};try{await load();sessionStorage.setItem('scr-company-code',auth.code);sessionStorage.setItem('scr-admin-email',auth.email);sessionStorage.setItem('scr-admin-password',auth.password);q('#login').style.display='none'}catch{clearAuth();q('#loginError').textContent='企業コード、管理者ID、またはパスワードが正しくありません'}};
q('#overviewMenu').onclick=()=>showPage('overview');q('#employeeManagement').onclick=()=>showPage('employees');
q('#logout').onclick=()=>{clearAuth();showPage('overview');q('#loginForm').reset();q('#loginError').textContent='';q('#error').style.display='none';q('#status').textContent='● ログインが必要です';q('#login').style.display='grid'};
if(auth.code&&auth.email&&auth.password)load().then(()=>q('#login').style.display='none').catch(()=>{clearAuth();q('#loginError').textContent='保存済みの認証情報が無効です。再度ログインしてください'});`;

export const authenticatedDashboardPage = dashboardPage
  .replace("</style></head><body>", `${loginStyles}</style></head><body>${login}`)
  .replace(
    '<button class="active">',
    '<button class="active" id="overviewMenu">',
  )
  .replace(
    '<small>GOVERNANCE</small>',
    '<button id="employeeManagement">従業員管理</button><small>GOVERNANCE</small>',
  )
  .replace(
    '</main></div></div><script>',
    '</main><main class="employee-page" id="employeePage"><div class="eyebrow">Employee management</div><h1>従業員管理</h1><p class="page-description">登録されている従業員を参照できます。</p><section class="employee-panel"><table class="employee-table"><thead><tr><th>従業員</th><th>部署</th><th>最終同期</th><th>状態</th></tr></thead><tbody id="employeeRows"><tr><td colspan="4">読み込み中</td></tr></tbody></table></section></main></div></div><script>',
  )
  .replace(
    /<span class="status" id="status">[^<]*<\/span>/,
    '<div class="topbar-actions"><span class="status" id="status">● データ同期中</span><button class="logout" id="logout" type="button">ログアウト</button></div>',
  )
  .replace(
    "const q=s=>document.querySelector(s);let source=null;",
    `const q=s=>document.querySelector(s);let source=null;let auth={code:sessionStorage.getItem('scr-company-code')||'',email:sessionStorage.getItem('scr-admin-email')||'',password:sessionStorage.getItem('scr-admin-password')||''};${categoryScript}`,
  )
  .replace(
    "fetch('/api/dashboard/summary',{cache:'no-store'})",
    "fetch('/api/dashboard/summary',{cache:'no-store',headers:{'x-company-code':auth.code,'x-admin-email':auth.email,'x-admin-password':auth.password}})",
  )
  .replace(
    "source=await response.json();const periodOptions=",
    "source=await response.json();if(source.company?.name)q('.company').textContent=source.company.name;q('#employeeRows').innerHTML=source.employees?.length?source.employees.map(item=>'<tr><td>'+esc(item.display_name)+'</td><td>'+esc(item.department)+'</td><td>'+fmtDate(item.last_seen_at)+'</td><td><span class=\"employee-status\">登録済み</span></td></tr>').join(''):'<tr><td colspan=\"4\">登録されている従業員はいません</td></tr>';const periodOptions=",
  )
  .replaceAll("esc(item.category)", "esc(categoryLabel(item.category))")
  .replace(
    /q\('#status'\)\.textContent='([^']+)'}finally/,
    "q('#status').textContent='$1';throw error}finally",
  )
  .replace("q('#refresh').onclick=load;load();", `q('#refresh').onclick=load;${authScript}`);

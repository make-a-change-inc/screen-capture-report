import { dashboardPage } from "./dashboard-page.js";

const login = `<div id="login" class="admin-login"><form id="loginForm" class="admin-login-card">
<div class="eyebrow">Owner access</div><h2>管理画面ログイン</h2>
<p>企業コード、管理者ID、パスワードを入力してください。</p>
<input id="companyCode" autocomplete="organization" placeholder="企業コード" maxlength="100" required>
<input id="adminEmail" type="email" autocomplete="username" placeholder="管理者ID（メールアドレス）" required>
<input id="adminPassword" type="password" autocomplete="current-password" placeholder="パスワード" required>
<button type="submit">ログイン</button><p id="loginError" class="admin-login-error"></p>
</form></div>`;

const loginStyles = `.admin-login{position:fixed;inset:0;display:grid;place-items:center;background:#10131a;z-index:10}.admin-login-card{width:min(420px,92vw);background:#fff;border-radius:16px;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.35)}.admin-login-card h2{margin:8px 0}.admin-login-card p{color:#697083}.admin-login-card input{display:block;width:100%;padding:11px;margin:8px 0;border:1px solid #dfe2e8;border-radius:7px}.admin-login-card button{width:100%;margin-top:4px;background:#2459ad;color:#fff;border:0;border-radius:7px;padding:11px;font-weight:700}.admin-login-error{color:#a23!important}.topbar-actions{display:flex;align-items:center;gap:14px}.logout{border:1px solid #dfe2e8;background:#fff;color:#16181d;border-radius:7px;padding:7px 11px;cursor:pointer}.employee-nav{margin-top:28px;border-top:1px solid #303754;padding-top:18px}.employee-nav>small{display:block;color:#757eaa;font-size:10px;letter-spacing:.14em;margin:0 10px 8px}.employee-list{max-height:230px;overflow:auto}.employee-item{padding:8px 10px;border-radius:7px;color:#fff}.employee-item b{display:block;font-size:12px}.employee-item span{display:block;color:#9199ba;font-size:10px}.employee-empty{padding:8px 10px;color:#9199ba;font-size:11px}`;

const categoryScript = `
const categoryLabels={other:'その他',administration:'管理・事務',development:'開発',research:'調査・リサーチ',chat_meeting:'チャット・会議',meeting:'会議',documents:'資料作成',document:'資料作成',email:'メール',input:'データ入力',data_entry:'データ入力',marketing:'マーケティング',sns:'SNS・マーケティング',accounting:'経理',account:'経理'};
function categoryLabel(value){return categoryLabels[String(value||'').toLowerCase()]||String(value||'未分類')}`;

const authScript = `
function clearAuth(){for(const key of ['scr-company-code','scr-admin-email','scr-admin-password'])sessionStorage.removeItem(key);auth={code:'',email:'',password:''}}
q('#loginForm').onsubmit=async event=>{event.preventDefault();q('#loginError').textContent='';auth={code:q('#companyCode').value.trim(),email:q('#adminEmail').value.trim(),password:q('#adminPassword').value};try{await load();sessionStorage.setItem('scr-company-code',auth.code);sessionStorage.setItem('scr-admin-email',auth.email);sessionStorage.setItem('scr-admin-password',auth.password);q('#login').style.display='none'}catch{clearAuth();q('#loginError').textContent='企業コード、管理者ID、またはパスワードが正しくありません'}};
q('#logout').onclick=()=>{clearAuth();q('#loginForm').reset();q('#loginError').textContent='';q('#error').style.display='none';q('#status').textContent='● ログインが必要です';q('#login').style.display='grid'};
if(auth.code&&auth.email&&auth.password)load().then(()=>q('#login').style.display='none').catch(()=>{clearAuth();q('#loginError').textContent='保存済みの認証情報が無効です。再度ログインしてください'});`;

export const authenticatedDashboardPage = dashboardPage
  .replace("</style></head><body>", `${loginStyles}</style></head><body>${login}`)
  .replace(
    '</nav><div class="privacy">',
    '</nav><section class="employee-nav"><small>従業員</small><div class="employee-list" id="sidebarEmployees"><div class="employee-empty">読み込み中</div></div></section><div class="privacy">',
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
    "source=await response.json();if(source.company?.name)q('.company').textContent=source.company.name;q('#sidebarEmployees').innerHTML=source.employees?.length?source.employees.map(item=>'<div class=\"employee-item\"><b>'+esc(item.display_name)+'</b><span>'+esc(item.department)+'</span></div>').join(''):'<div class=\"employee-empty\">登録なし</div>';const periodOptions=",
  )
  .replaceAll("esc(item.category)", "esc(categoryLabel(item.category))")
  .replace(
    /q\('#status'\)\.textContent='([^']+)'}finally/,
    "q('#status').textContent='$1';throw error}finally",
  )
  .replace("q('#refresh').onclick=load;load();", `q('#refresh').onclick=load;${authScript}`);

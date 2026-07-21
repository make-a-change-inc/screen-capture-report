import { dashboardPage as page } from "./dashboard-page.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });

const hex = (buffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const base64ToBytes = (value) => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const bytesToBase64 = (value) => {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

async function sha256(value) {
  return hex(await crypto.subtle.digest("SHA-256", typeof value === "string" ? enc.encode(value) : value));
}

async function timingSafeMatch(value, expectedHash) {
  if (!value || !expectedHash) return false;
  const actual = await sha256(value);
  if (actual.length !== expectedHash.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }
  return difference === 0;
}

async function reportKey(env) {
  const raw = base64ToBytes(env.REPORT_ENCRYPTION_KEY_V1 || "");
  if (raw.byteLength !== 32) throw new Error("invalid_report_encryption_key");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptReport(env, value) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await reportKey(env),
    enc.encode(value),
  );
  return { cipher, nonce };
}

async function decryptReport(env, cipher, nonce) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(nonce) },
    await reportKey(env),
    new Uint8Array(cipher),
  );
  return dec.decode(plain);
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
    department TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, employee_id TEXT NOT NULL,
    name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active',
    app_version TEXT, last_seen_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, employee_id TEXT NOT NULL,
    device_id TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind='weekly'), audience TEXT NOT NULL CHECK(audience='management'),
    schema_version INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    content_cipher BLOB NOT NULL, content_nonce BLOB NOT NULL, content_sha256 TEXT NOT NULL,
    generated_at TEXT NOT NULL, received_at TEXT NOT NULL,
    UNIQUE(employee_id, period_start, kind, audience))`,
  `CREATE TABLE IF NOT EXISTS report_metrics (report_id TEXT PRIMARY KEY,
    active_minutes INTEGER, idle_minutes INTEGER, categories_json TEXT NOT NULL DEFAULT '[]',
    capture_count INTEGER, work_log_count INTEGER)`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (device_id TEXT NOT NULL, key TEXT NOT NULL,
    request_sha256 TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(device_id, key))`,
  `CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, actor_type TEXT NOT NULL,
    actor_id TEXT, action TEXT NOT NULL, target_type TEXT, target_id TEXT,
    occurred_at TEXT NOT NULL, metadata_json TEXT)`,
];

async function ensureSchema(env) {
  if (!env.DB) throw new Error("database_binding_missing");
  await env.DB.batch(schemaStatements.map((statement) => env.DB.prepare(statement)));
}

async function requireAdmin(request, env) {
  const email = (request.headers.get("x-admin-email") || "").trim().toLowerCase();
  const password = request.headers.get("x-admin-password") || "";
  const expectedEmail = (env.ADMIN_EMAIL || "admin@screen-capture-report.local").trim().toLowerCase();
  const expectedPasswordHash = env.ADMIN_PASSWORD_HASH || env.BOOTSTRAP_ADMIN_HASH || "";
  return email === expectedEmail && timingSafeMatch(password, expectedPasswordHash);
}

async function requireDevice(request, env) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return null;
  const tokenHash = await sha256(authorization.slice(7));
  const device = await env.DB.prepare(
    `SELECT devices.*, employees.display_name, employees.department
     FROM devices JOIN employees ON employees.id=devices.employee_id
     WHERE devices.token_hash=? AND devices.status='active' AND employees.status='active'`,
  ).bind(tokenHash).first();
  return device || null;
}

async function audit(env, actorType, actorId, action, targetType, targetId, metadata = {}) {
  await env.DB.prepare(
    `INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), actorType, actorId || null, action, targetType || null,
    targetId || null, new Date().toISOString(), JSON.stringify(metadata),
  ).run();
}

async function createDevice(request, env) {
  const body = await request.json();
  const displayName = String(body.displayName || "").trim();
  const department = String(body.department || "").trim();
  const deviceName = String(body.deviceName || "").trim();
  if (!displayName || !department || !deviceName) return json({ error: "invalid_input" }, 400);
  const employeeId = body.employeeId || crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToBase64(tokenBytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO employees (id, display_name, department, status, created_at)
       VALUES (?, ?, ?, 'active', ?)
       ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,
       department=excluded.department, status='active'`,
    ).bind(employeeId, displayName, department, now),
    env.DB.prepare(
      `INSERT INTO devices (id, employee_id, name, token_hash, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    ).bind(deviceId, employeeId, deviceName, await sha256(token), now),
  ]);
  await audit(env, "admin", "owner", "device.created", "device", deviceId, { employeeId });
  return json({ employeeId, deviceId, deviceToken: token }, 201);
}

function normalizeReport(body) {
  const reportHtml = String(body.report_html || body?.artifact?.content || "");
  return {
    schemaVersion: Number(body.schema_version || body.schemaVersion || 1),
    reportId: String(body.report_id || body.reportId || ""),
    periodStart: String(body.period_start || body.periodStart || ""),
    periodEnd: String(body.period_end || body.periodEnd || ""),
    revision: Number(body.revision || 1),
    generatedAt: String(body.generated_at || body.generatedAt || new Date().toISOString()),
    reportHtml,
    metrics: body.metrics || {},
  };
}

async function uploadReport(request, env) {
  const device = await requireDevice(request, env);
  if (!device) return json({ error: "invalid_device_token" }, 401);
  const raw = await request.arrayBuffer();
  if (raw.byteLength > 700 * 1024) return json({ error: "payload_too_large" }, 413);
  const requestHash = await sha256(raw);
  const idempotencyKey = request.headers.get("idempotency-key") || "";
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return json({ error: "idempotency_key_required" }, 400);
  }
  const previous = await env.DB.prepare(
    "SELECT request_sha256, response_json FROM idempotency_keys WHERE device_id=? AND key=?",
  ).bind(device.id, idempotencyKey).first();
  if (previous) {
    if (previous.request_sha256 !== requestHash) return json({ error: "idempotency_conflict" }, 409);
    return new Response(previous.response_json, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const body = JSON.parse(dec.decode(raw));
  if (
    (body.kind && body.kind !== "weekly")
    || (body.audience && body.audience !== "management")
    || body.finalized !== true
  ) {
    return json({ error: "only_weekly_management_reports_are_accepted" }, 422);
  }
  const report = normalizeReport(body);
  const startAt = Date.parse(report.periodStart + "T00:00:00Z");
  const endAt = Date.parse(report.periodEnd + "T00:00:00Z");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(report.reportId)
      || !/^\d{4}-\d{2}-\d{2}$/.test(report.periodStart)
      || !/^\d{4}-\d{2}-\d{2}$/.test(report.periodEnd)
      || endAt - startAt !== 6 * 86400 * 1000
      || report.schemaVersion !== 1
      || !Number.isInteger(report.revision)
      || report.revision < 1
      || !report.reportHtml.trim()) {
    return json({ error: "invalid_report" }, 400);
  }
  if (enc.encode(report.reportHtml).byteLength > 512 * 1024) {
    return json({ error: "report_too_large" }, 413);
  }
  const existing = await env.DB.prepare(
    `SELECT id, revision FROM reports WHERE employee_id=? AND period_start=?
     AND kind='weekly' AND audience='management'`,
  ).bind(device.employee_id, report.periodStart).first();
  if (existing && Number(existing.revision) > report.revision) {
    return json({ error: "stale_revision" }, 409);
  }
  const encrypted = await encryptReport(env, report.reportHtml);
  const contentHash = await sha256(report.reportHtml);
  const now = new Date().toISOString();
  const reportId = existing?.id || report.reportId;
  const responseBody = JSON.stringify({ ok: true, reportId, receivedAt: now });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO reports (id, employee_id, device_id, period_start, period_end, kind,
       audience, schema_version, revision, content_cipher, content_nonce, content_sha256,
       generated_at, received_at) VALUES (?, ?, ?, ?, ?, 'weekly', 'management', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(employee_id, period_start, kind, audience) DO UPDATE SET
       device_id=excluded.device_id, period_end=excluded.period_end,
       schema_version=excluded.schema_version, revision=excluded.revision,
       content_cipher=excluded.content_cipher, content_nonce=excluded.content_nonce,
       content_sha256=excluded.content_sha256, generated_at=excluded.generated_at,
       received_at=excluded.received_at`,
    ).bind(
      reportId, device.employee_id, device.id, report.periodStart, report.periodEnd,
      report.schemaVersion, report.revision, encrypted.cipher, encrypted.nonce,
      contentHash, report.generatedAt, now,
    ),
    env.DB.prepare(
      `INSERT INTO report_metrics (report_id, active_minutes, idle_minutes, categories_json,
       capture_count, work_log_count) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(report_id) DO UPDATE SET active_minutes=excluded.active_minutes,
       idle_minutes=excluded.idle_minutes, categories_json=excluded.categories_json,
       capture_count=excluded.capture_count, work_log_count=excluded.work_log_count`,
    ).bind(
      reportId, report.metrics.activeMinutes ?? null, report.metrics.idleMinutes ?? null,
      JSON.stringify(report.metrics.categories || []), report.metrics.captureCount ?? null,
      report.metrics.workLogCount ?? null,
    ),
    env.DB.prepare(
      "INSERT INTO idempotency_keys VALUES (?, ?, ?, ?, ?)",
    ).bind(device.id, idempotencyKey, requestHash, responseBody, now),
    env.DB.prepare("UPDATE devices SET last_seen_at=? WHERE id=?").bind(now, device.id),
  ]);
  await audit(env, "device", device.id, "report.received", "report", reportId, {
    periodStart: report.periodStart,
    contentSha256: contentHash,
  });
  return new Response(responseBody, {
    status: existing ? 200 : 201,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function listSummary(env) {
  const [employees, reports, departments] = await Promise.all([
    env.DB.prepare(
      `SELECT e.id, e.display_name, e.department, e.status, MAX(d.last_seen_at) AS last_seen_at,
       COUNT(DISTINCT d.id) AS device_count, MAX(r.period_start) AS latest_period
       FROM employees e LEFT JOIN devices d ON d.employee_id=e.id
       LEFT JOIN reports r ON r.employee_id=e.id GROUP BY e.id ORDER BY e.display_name`,
    ).all(),
    env.DB.prepare(
      `SELECT r.id, r.employee_id, e.display_name, e.department, r.period_start, r.period_end,
       r.revision, r.generated_at, r.received_at, r.content_sha256, m.active_minutes,
       m.idle_minutes, m.categories_json FROM reports r
       JOIN employees e ON e.id=r.employee_id LEFT JOIN report_metrics m ON m.report_id=r.id
       ORDER BY r.period_start DESC, e.display_name LIMIT 200`,
    ).all(),
    env.DB.prepare("SELECT department, COUNT(*) AS count FROM employees GROUP BY department").all(),
  ]);
  return json({
    employees: employees.results,
    reports: reports.results.map((item) => ({
      ...item,
      categories: JSON.parse(item.categories_json || "[]"),
      categories_json: undefined,
    })),
    departments: departments.results,
    refreshedAt: new Date().toISOString(),
  });
}

async function reportContent(env, reportId) {
  const report = await env.DB.prepare(
    "SELECT content_cipher, content_nonce, content_sha256 FROM reports WHERE id=?",
  ).bind(reportId).first();
  if (!report) return json({ error: "not_found" }, 404);
  const html = await decryptReport(env, report.content_cipher, report.content_nonce);
  const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
  return json({ html, sha256: report.content_sha256, csp });
}

async function runRetention(env) {
  await ensureSchema(env);
  const reportCutoff = new Date(Date.now() - 90 * 86400 * 1000).toISOString();
  const auditCutoff = new Date(Date.now() - 365 * 86400 * 1000).toISOString();
  const expired = await env.DB.prepare(
    "SELECT id FROM reports WHERE received_at < ? LIMIT 500",
  ).bind(reportCutoff).all();
  const statements = [];
  for (const row of expired.results) {
    statements.push(env.DB.prepare("DELETE FROM report_metrics WHERE report_id=?").bind(row.id));
    statements.push(env.DB.prepare("DELETE FROM reports WHERE id=?").bind(row.id));
    statements.push(
      env.DB.prepare("INSERT INTO audit_events VALUES (?, 'system', NULL, 'report.expired', 'report', ?, ?, '{}')")
        .bind(crypto.randomUUID(), row.id, new Date().toISOString()),
    );
  }
  statements.push(env.DB.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").bind(reportCutoff));
  statements.push(env.DB.prepare("DELETE FROM audit_events WHERE occurred_at < ?").bind(auditCutoff));
  await env.DB.batch(statements);
}

async function adminApi(request, env, pathname) {
  if (!(await requireAdmin(request, env))) return json({ error: "admin_auth_required" }, 401);
  if (request.method === "GET" && pathname === "/api/admin/summary") return listSummary(env);
  if (request.method === "POST" && pathname === "/api/admin/devices") return createDevice(request, env);
  const contentMatch = pathname.match(/^\/api\/admin\/reports\/([^/]+)\/content$/);
  if (request.method === "GET" && contentMatch) return reportContent(env, contentMatch[1]);
  return json({ error: "not_found" }, 404);
}

const legacyPage = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Screen Capture Report</title><style>
:root{color-scheme:light;--ink:#18242c;--muted:#667780;--paper:#f4f6f3;--card:#fff;--line:#dce3dd;--green:#2f6b55;--green2:#dfece5;--amber:#b87824;--shadow:0 12px 34px rgba(24,36,44,.08)}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 Inter,"Segoe UI",sans-serif}.shell{display:grid;grid-template-columns:240px 1fr;min-height:100vh}.side{background:#183c32;color:#eff8f3;padding:28px 20px;position:sticky;top:0;height:100vh}.brand{font-size:18px;font-weight:750;letter-spacing:-.02em}.brand small{display:block;font-size:11px;opacity:.7;letter-spacing:.12em;text-transform:uppercase;margin-bottom:7px}.nav{margin-top:38px}.nav a{display:block;color:#d8e8e1;text-decoration:none;padding:10px 12px;border-radius:10px;margin:5px 0}.nav a.active,.nav a:hover{background:rgba(255,255,255,.1);color:white}.privacy{position:absolute;bottom:22px;left:20px;right:20px;font-size:11px;color:#b9d1c6;border-top:1px solid rgba(255,255,255,.14);padding-top:16px}.main{padding:34px clamp(22px,4vw,60px)}header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}.eyebrow{color:var(--green);font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}h1{font-size:30px;margin:5px 0 2px;letter-spacing:-.035em}p.sub{color:var(--muted);margin:0}.actions{display:flex;gap:9px}button,input{font:inherit}button{border:0;border-radius:10px;padding:10px 14px;background:var(--green);color:white;font-weight:650;cursor:pointer}button.ghost{background:white;color:var(--ink);border:1px solid var(--line)}.cards{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:14px;margin:28px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:var(--shadow)}.card .label{color:var(--muted);font-size:12px}.card strong{display:block;font-size:28px;margin-top:5px;letter-spacing:-.04em}.grid{display:grid;grid-template-columns:1.35fr .65fr;gap:16px}.panel{background:white;border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}.panel-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid var(--line)}.panel h2{font-size:16px;margin:0}.panel-body{padding:18px 20px}.filters{display:flex;gap:8px}.filters input{border:1px solid var(--line);background:#fafbf9;border-radius:9px;padding:8px 10px;min-width:190px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px 9px;border-bottom:1px solid #edf0ed;vertical-align:top}th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}tr[data-id]{cursor:pointer}tr[data-id]:hover{background:#f4f8f5}.pill{display:inline-flex;border-radius:999px;padding:3px 8px;background:var(--green2);color:var(--green);font-size:11px;font-weight:700}.employee{padding:12px 0;border-bottom:1px solid #edf0ed}.employee:last-child{border:0}.employee b{display:block}.employee small{color:var(--muted)}dialog{border:0;border-radius:18px;box-shadow:0 28px 80px rgba(0,0,0,.25);width:min(920px,92vw);padding:0}dialog::backdrop{background:rgba(11,25,21,.58)}.dialog-head{padding:18px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between}.dialog-body{padding:20px}iframe{width:100%;height:62vh;border:1px solid var(--line);border-radius:12px;background:white}.login{position:fixed;inset:0;display:grid;place-items:center;background:#15352d;z-index:5}.login-card{width:min(420px,90vw);background:white;border-radius:20px;padding:30px;box-shadow:0 24px 80px rgba(0,0,0,.3)}.login h2{margin:0 0 8px}.login input{width:100%;border:1px solid var(--line);border-radius:10px;padding:11px;margin:15px 0 10px}.error{color:#a33;font-size:12px}.device-form{display:grid;grid-template-columns:1fr 1fr;gap:10px}.device-form input{border:1px solid var(--line);border-radius:9px;padding:9px}.device-form button{grid-column:1/-1}.token{word-break:break-all;background:#eef4f0;padding:10px;border-radius:9px;font-family:monospace;font-size:12px}@media(max-width:900px){.shell{grid-template-columns:1fr}.side{display:none}.cards{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.main{padding:24px 16px}}@media(max-width:520px){.cards{grid-template-columns:1fr 1fr}header{display:block}.actions{margin-top:14px}.filters{display:none}}
</style></head><body><div id="login" class="login"><form id="loginForm" class="login-card"><div class="eyebrow">Owner access</div><h2>管理ダッシュボード</h2><p class="sub">管理者のメールアドレスとパスワードでログインします。</p><input id="adminEmail" type="email" autocomplete="username" placeholder="メールアドレス" required><input id="adminPassword" type="password" autocomplete="current-password" placeholder="パスワード" required><button type="submit">ダッシュボードを開く</button><p id="loginError" class="error"></p></form></div><div class="shell"><aside class="side"><div class="brand"><small>Workflow intelligence</small>Screen Capture Report</div><nav class="nav"><a class="active" href="#overview">概要</a><a href="#reports">週次レポート</a><a href="#devices">端末登録</a></nav><div class="privacy">管理者画面に生画像・本人日報・ウィンドウタイトルは保存されません。</div></aside><main class="main"><header><div><div class="eyebrow">Management overview</div><h1>業務改善レポート</h1><p class="sub" id="freshness">データを読み込んでいます</p></div><div class="actions"><button class="ghost" id="refresh">更新</button><button id="register">端末を登録</button></div></header><section class="cards"><div class="card"><span class="label">登録従業員</span><strong id="employeeCount">—</strong></div><div class="card"><span class="label">週次レポート</span><strong id="reportCount">—</strong></div><div class="card"><span class="label">同期済み端末</span><strong id="deviceCount">—</strong></div><div class="card"><span class="label">対象部署</span><strong id="departmentCount">—</strong></div></section><section class="grid"><div class="panel" id="reports"><div class="panel-head"><h2>最新の週次レポート</h2><div class="filters"><input id="search" placeholder="氏名・部署で絞り込み"></div></div><div class="panel-body"><table><thead><tr><th>従業員</th><th>対象週</th><th>受信日時</th><th>状態</th></tr></thead><tbody id="reportRows"><tr><td colspan="4">レポートはまだありません</td></tr></tbody></table></div></div><div><div class="panel"><div class="panel-head"><h2>従業員</h2></div><div class="panel-body" id="employees">登録なし</div></div><div class="panel" id="devices" style="margin-top:16px"><div class="panel-head"><h2>データ境界</h2></div><div class="panel-body"><p><span class="pill">端末内のみ</span> 本人日報・キャプチャ</p><p><span class="pill">管理Web</span> 確定済み週次管理レポート</p></div></div></div></section></main></div><dialog id="reportDialog"><div class="dialog-head"><div><b id="reportTitle">週次レポート</b><div class="sub" id="reportHash"></div></div><button class="ghost" data-close>閉じる</button></div><div class="dialog-body"><iframe id="reportFrame" sandbox=""></iframe></div></dialog><dialog id="deviceDialog"><div class="dialog-head"><b>端末を登録</b><button class="ghost" data-close>閉じる</button></div><div class="dialog-body"><form id="deviceForm" class="device-form"><input name="displayName" placeholder="従業員名" required><input name="department" placeholder="部署" required><input name="deviceName" placeholder="端末名" required><input name="employeeId" placeholder="既存従業員ID（任意）"><button type="submit">登録トークンを発行</button></form><div id="deviceTokenBox"></div></div></dialog><script>
let adminEmail=sessionStorage.getItem('scr-admin-email')||'';let adminPassword=sessionStorage.getItem('scr-admin-password')||'';let data={employees:[],reports:[],departments:[]};const qs=s=>document.querySelector(s);async function api(path,options={}){const headers={...(options.headers||{}),'x-admin-email':adminEmail,'x-admin-password':adminPassword};const response=await fetch(path,{...options,headers});if(response.status===401)throw new Error('unauthorized');if(!response.ok)throw new Error('request_failed_'+response.status);return response.json()}function formatDate(value){if(!value)return'—';return new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value))}function escapeHtml(value){const el=document.createElement('span');el.textContent=String(value??'');return el.innerHTML}function render(){qs('#employeeCount').textContent=data.employees.length;qs('#reportCount').textContent=data.reports.length;qs('#deviceCount').textContent=data.employees.reduce((sum,item)=>sum+Number(item.device_count||0),0);qs('#departmentCount').textContent=data.departments.length;qs('#freshness').textContent='最終更新 '+formatDate(data.refreshedAt);qs('#employees').innerHTML=data.employees.length?data.employees.map(item=>'<div class="employee"><b>'+escapeHtml(item.display_name)+'</b><small>'+escapeHtml(item.department)+' · 最新 '+escapeHtml(item.latest_period||'未同期')+'</small></div>').join(''):'登録なし';renderRows()}function renderRows(){const query=qs('#search').value.toLowerCase();const rows=data.reports.filter(item=>(item.display_name+' '+item.department).toLowerCase().includes(query));qs('#reportRows').innerHTML=rows.length?rows.map(item=>'<tr data-id="'+escapeHtml(item.id)+'"><td><b>'+escapeHtml(item.display_name)+'</b><br><small>'+escapeHtml(item.department)+'</small></td><td>'+escapeHtml(item.period_start)+'〜'+escapeHtml(item.period_end)+'</td><td>'+formatDate(item.received_at)+'</td><td><span class="pill">同期済み</span></td></tr>').join(''):'<tr><td colspan="4">該当するレポートはありません</td></tr>';document.querySelectorAll('tr[data-id]').forEach(row=>row.onclick=()=>openReport(row.dataset.id))}async function load(){data=await api('/api/admin/summary');render()}async function openReport(id){const item=data.reports.find(report=>report.id===id);const content=await api('/api/admin/reports/'+encodeURIComponent(id)+'/content');qs('#reportTitle').textContent=(item?.display_name||'')+' · '+(item?.period_start||'');qs('#reportHash').textContent='SHA-256 '+content.sha256;const csp='<meta http-equiv="Content-Security-Policy" content="'+content.csp.replaceAll('"','&quot;')+'">';qs('#reportFrame').srcdoc=csp+content.html;qs('#reportDialog').showModal()}qs('#loginForm').onsubmit=async event=>{event.preventDefault();adminEmail=qs('#adminEmail').value.trim();adminPassword=qs('#adminPassword').value;try{await load();sessionStorage.setItem('scr-admin-email',adminEmail);sessionStorage.setItem('scr-admin-password',adminPassword);qs('#login').style.display='none'}catch(error){qs('#loginError').textContent='メールアドレスまたはパスワードが正しくありません'}};qs('#refresh').onclick=()=>load();qs('#search').oninput=renderRows;qs('#register').onclick=()=>qs('#deviceDialog').showModal();document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>button.closest('dialog').close());qs('#deviceForm').onsubmit=async event=>{event.preventDefault();const form=new FormData(event.target);const payload=Object.fromEntries(form.entries());const result=await api('/api/admin/devices',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});qs('#deviceTokenBox').innerHTML='<p><b>このトークンは一度だけ表示されます。</b></p><div class="token">'+escapeHtml(result.deviceToken)+'</div>';await load()};if(adminEmail&&adminPassword)load().then(()=>qs('#login').style.display='none').catch(()=>{sessionStorage.removeItem('scr-admin-email');sessionStorage.removeItem('scr-admin-password')});
</script></body></html>`;

export default {
  async fetch(request, env) {
    try {
      await ensureSchema(env);
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/admin/")) return adminApi(request, env, url.pathname);
      if (
        request.method === "POST"
        && ["/api/device/reports", "/api/v1/device/reports/weekly-management"].includes(url.pathname)
      ) return uploadReport(request, env);
      if (url.pathname === "/api/health") return json({ ok: true, database: true });
      if (request.method !== "GET" || url.pathname !== "/") return json({ error: "not_found" }, 404);
      return new Response(page, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
          "x-frame-options": "DENY",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      });
    } catch (error) {
      return json({ error: "internal_error", type: error?.name || "Error" }, 500);
    }
  },
  async scheduled(_controller, env) {
    await runRetention(env);
  },
};

export { decryptReport, encryptReport, normalizeReport, runRetention, sha256, timingSafeMatch };

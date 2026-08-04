import { authenticatedDashboardPage as page } from "./authenticated-dashboard-page.js";

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

const randomToken = (size = 32) => bytesToBase64(crypto.getRandomValues(new Uint8Array(size)))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const cookieValue = (request, name) => {
  const cookies = request.headers.get("cookie") || "";
  for (const item of cookies.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
};

const sessionCookie = (token, maxAge = 28800) =>
  `scr_admin_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

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
  `CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL)`,
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
  `CREATE TABLE IF NOT EXISTS company_employees (company_id TEXT NOT NULL,
    employee_id TEXT NOT NULL UNIQUE, external_employee_id TEXT NOT NULL,
    PRIMARY KEY(company_id, external_employee_id))`,
  `CREATE TABLE IF NOT EXISTS company_devices (company_id TEXT NOT NULL,
    device_id TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS company_reports (company_id TEXT NOT NULL,
    report_id TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, company_id TEXT NOT NULL,
    email TEXT NOT NULL, csrf_token TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS admin_login_attempts (attempt_key TEXT PRIMARY KEY, attempt_count INTEGER NOT NULL,
    window_started_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS company_settings (company_id TEXT PRIMARY KEY, timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
    week_start INTEGER NOT NULL DEFAULT 1, report_retention_days INTEGER NOT NULL DEFAULT 90,
    audit_retention_days INTEGER NOT NULL DEFAULT 365, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_events_occurred ON audit_events(occurred_at DESC)`,
  `CREATE TABLE IF NOT EXISTS report_versions (id TEXT PRIMARY KEY, report_id TEXT NOT NULL,
    revision INTEGER NOT NULL, content_cipher BLOB NOT NULL, content_nonce BLOB NOT NULL,
    content_sha256 TEXT NOT NULL, generated_at TEXT NOT NULL, received_at TEXT NOT NULL,
    created_at TEXT NOT NULL, UNIQUE(report_id, revision))`,
  `CREATE TABLE IF NOT EXISTS report_workflows (report_id TEXT PRIMARY KEY, company_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'finalized', review_note TEXT, updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS opportunity_states (company_id TEXT NOT NULL, opportunity_key TEXT NOT NULL,
    department TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', owner TEXT,
    next_action TEXT, decision_reason TEXT, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(company_id, opportunity_key))`,
  `CREATE TABLE IF NOT EXISTS classification_rules (company_id TEXT NOT NULL, category TEXT NOT NULL,
    display_name TEXT NOT NULL, automation_rate REAL NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(company_id, category))`,
  `CREATE TABLE IF NOT EXISTS privacy_requests (id TEXT PRIMARY KEY, company_id TEXT NOT NULL,
    request_type TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'requested',
    reason TEXT, requested_by TEXT NOT NULL, requested_at TEXT NOT NULL, resolved_by TEXT,
    resolved_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS consent_events (id TEXT PRIMARY KEY, company_id TEXT NOT NULL,
    employee_id TEXT, status TEXT NOT NULL, source TEXT NOT NULL, occurred_at TEXT NOT NULL,
    recorded_by TEXT NOT NULL)`,
];

async function ensureSchema(env) {
  if (!env.DB) throw new Error("database_binding_missing");
  await env.DB.batch(schemaStatements.map((statement) => env.DB.prepare(statement)));
}

async function companyByCode(env, companyCode) {
  if (!companyCode || companyCode.length > 100) return null;
  return env.DB.prepare(
    "SELECT id, name FROM companies WHERE code_hash=? AND status='active'",
  ).bind(await sha256(companyCode)).first();
}

async function bootstrapCompany(env, companyCode, migrateLegacy = true, requestedName = "") {
  let company = await companyByCode(env, companyCode);
  if (company) {
    const companyName = String(requestedName || "").trim().slice(0, 128);
    if (!migrateLegacy && companyName && companyName !== company.name) {
      await env.DB.prepare("UPDATE companies SET name=? WHERE id=?").bind(
        companyName, company.id,
      ).run();
      company = { ...company, name: companyName };
    }
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM companies").first();
    if (migrateLegacy && Number(count?.count || 0) === 1) {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO company_employees (company_id, employee_id, external_employee_id)
           SELECT ?, id, id FROM employees`,
        ).bind(company.id),
        env.DB.prepare(
          "INSERT OR IGNORE INTO company_devices (company_id, device_id) SELECT ?, id FROM devices",
        ).bind(company.id),
        env.DB.prepare(
          "INSERT OR IGNORE INTO company_reports (company_id, report_id) SELECT ?, id FROM reports",
        ).bind(company.id),
      ]);
    }
    return company;
  }
  if (!companyCode || companyCode.length > 100) return null;
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM companies").first();
  const isFirstCompany = Number(count?.count || 0) === 0;
  const companyId = crypto.randomUUID();
  const now = new Date().toISOString();
  const companyName = String(requestedName || "").trim().slice(0, 128);
  const statements = [
    env.DB.prepare(
      "INSERT INTO companies (id, code_hash, name, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).bind(
      companyId, await sha256(companyCode),
      companyName || (isFirstCompany ? env.DEFAULT_COMPANY_NAME || "既存企業" : "Company"), now,
    ),
  ];
  if (isFirstCompany && migrateLegacy) statements.push(
    env.DB.prepare(
      `INSERT OR IGNORE INTO company_employees (company_id, employee_id, external_employee_id)
       SELECT ?, id, id FROM employees`,
    ).bind(companyId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO company_devices (company_id, device_id) SELECT ?, id FROM devices",
    ).bind(companyId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO company_reports (company_id, report_id) SELECT ?, id FROM reports",
    ).bind(companyId),
  );
  await env.DB.batch(statements);
  return companyByCode(env, companyCode);
}

async function requireAdmin(request, env) {
  const token = cookieValue(request, "scr_admin_session");
  if (!token) return null;
  const session = await env.DB.prepare(
    `SELECT s.company_id, s.email, s.csrf_token, s.expires_at, c.name
     FROM admin_sessions s JOIN companies c ON c.id=s.company_id
     WHERE s.token_hash=? AND s.expires_at>? AND c.status='active'`,
  ).bind(await sha256(token), new Date().toISOString()).first();
  return session ? { id: session.company_id, name: session.name, email: session.email,
    csrfToken: session.csrf_token, sessionToken: token } : null;
}

async function login(request, env) {
  const body = await request.json();
  const companyCode = String(body.companyCode || "");
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const expectedEmail = (env.ADMIN_EMAIL || "admin@screen-capture-report.local").trim().toLowerCase();
  const expectedPasswordHash = env.ADMIN_PASSWORD_HASH || env.BOOTSTRAP_ADMIN_HASH || "";
  const attemptKey = await sha256(`${request.headers.get("cf-connecting-ip") || "local"}|${email}`);
  const attempt = await env.DB.prepare(
    "SELECT attempt_count, window_started_at FROM admin_login_attempts WHERE attempt_key=?",
  ).bind(attemptKey).first();
  const now = new Date();
  const windowActive = attempt && now.getTime() - Date.parse(attempt.window_started_at) < 15 * 60 * 1000;
  if (windowActive && Number(attempt.attempt_count) >= 5) return json({ error: "login_rate_limited" }, 429);
  const company = await companyByCode(env, companyCode);
  if (!company || email !== expectedEmail || !(await timingSafeMatch(password, expectedPasswordHash))) {
    await env.DB.prepare(
      `INSERT INTO admin_login_attempts VALUES (?, 1, ?)
       ON CONFLICT(attempt_key) DO UPDATE SET
       attempt_count=CASE WHEN window_started_at<? THEN 1 ELSE attempt_count+1 END,
       window_started_at=CASE WHEN window_started_at<? THEN excluded.window_started_at ELSE window_started_at END`,
    ).bind(attemptKey, now.toISOString(), new Date(now.getTime() - 15 * 60 * 1000).toISOString(),
      new Date(now.getTime() - 15 * 60 * 1000).toISOString()).run();
    return json({ error: "invalid_credentials" }, 401);
  }
  const token = randomToken();
  const csrfToken = randomToken(24);
  const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at<=?").bind(now.toISOString()),
    env.DB.prepare("DELETE FROM admin_login_attempts WHERE attempt_key=?").bind(attemptKey),
    env.DB.prepare(
      "INSERT INTO admin_sessions VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(await sha256(token), company.id, email, csrfToken, now.toISOString(), expiresAt),
  ]);
  await audit(env, "admin", email, "session.login", "company", company.id);
  return json({ company: { id: company.id, name: company.name }, email, csrfToken, expiresAt }, 200,
    { "set-cookie": sessionCookie(token) });
}

async function logout(request, env) {
  const company = await requireAdmin(request, env);
  if (company) {
    await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?")
      .bind(await sha256(company.sessionToken)).run();
    await audit(env, "admin", company.email, "session.logout", "company", company.id);
  }
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
}

const validCsrf = (request, company) => {
  const origin = request.headers.get("origin");
  return request.headers.get("x-csrf-token") === company.csrfToken
    && (!origin || origin === new URL(request.url).origin);
};

async function requireDevice(request, env) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return null;
  const tokenHash = await sha256(authorization.slice(7));
  const device = await env.DB.prepare(
    `SELECT devices.*, employees.display_name, employees.department, cd.company_id
     FROM devices JOIN employees ON employees.id=devices.employee_id
     JOIN company_devices cd ON cd.device_id=devices.id
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
  const company = await requireAdmin(request, env);
  if (!company) return json({ error: "admin_auth_required" }, 401);
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
    env.DB.prepare(
      `INSERT OR REPLACE INTO company_employees
       (company_id, employee_id, external_employee_id) VALUES (?, ?, ?)`,
    ).bind(company.id, employeeId, String(body.employeeId || employeeId)),
    env.DB.prepare(
      "INSERT INTO company_devices (company_id, device_id) VALUES (?, ?)",
    ).bind(company.id, deviceId),
  ]);
  await audit(env, "admin", "owner", "device.created", "device", deviceId, { employeeId });
  return json({ employeeId, deviceId, deviceToken: token }, 201);
}

async function registerDevice(request, env) {
  if (env.ALLOW_SELF_REGISTRATION !== "true") {
    return json({ error: "self_registration_disabled" }, 403);
  }
  const body = await request.json();
  const company = await bootstrapCompany(
    env, String(body.companyCode || request.headers.get("x-company-code") || ""), false,
    String(body.companyName || ""),
  );
  if (!company) return json({ error: "invalid_company_code" }, 401);
  const externalEmployeeId = String(body.employeeId || body.displayName || "").trim();
  const department = String(body.department || "").trim();
  const deviceName = String(body.deviceName || "").trim();
  if (!externalEmployeeId || !department || !deviceName) {
    return json({ error: "invalid_input" }, 400);
  }
  let mapping = await env.DB.prepare(
    "SELECT employee_id FROM company_employees WHERE company_id=? AND external_employee_id=?",
  ).bind(company.id, externalEmployeeId).first();
  const employeeId = mapping?.employee_id || crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToBase64(tokenBytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO employees (id, display_name, department, status, created_at)
       VALUES (?, ?, ?, 'active', ?)
       ON CONFLICT(id) DO UPDATE SET department=excluded.department, status='active'`,
    ).bind(employeeId, externalEmployeeId, department, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO company_employees
       (company_id, employee_id, external_employee_id) VALUES (?, ?, ?)`,
    ).bind(company.id, employeeId, externalEmployeeId),
    env.DB.prepare(
      `INSERT INTO devices (id, employee_id, name, token_hash, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    ).bind(deviceId, employeeId, deviceName, await sha256(token), now),
    env.DB.prepare(
      "INSERT INTO company_devices (company_id, device_id) VALUES (?, ?)",
    ).bind(company.id, deviceId),
  ]);
  await audit(env, "device", deviceId, "device.self_registered", "company", company.id);
  return json({ employeeId: externalEmployeeId, deviceId, deviceToken: token }, 201);
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
    `SELECT id, revision, content_sha256 FROM reports WHERE employee_id=? AND period_start=?
     AND kind='weekly' AND audience='management'`,
  ).bind(device.employee_id, report.periodStart).first();
  if (existing && Number(existing.revision) > report.revision) {
    return json({ error: "stale_revision" }, 409);
  }
  const encrypted = await encryptReport(env, report.reportHtml);
  const contentHash = await sha256(report.reportHtml);
  if (existing && Number(existing.revision) === report.revision
      && existing.content_sha256 !== contentHash) {
    return json({ error: "revision_content_conflict" }, 409);
  }
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
    env.DB.prepare(
      "INSERT OR IGNORE INTO company_reports (company_id, report_id) VALUES (?, ?)",
    ).bind(device.company_id, reportId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO report_versions (id, report_id, revision, content_cipher,
       content_nonce, content_sha256, generated_at, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), reportId, report.revision, encrypted.cipher, encrypted.nonce,
      contentHash, report.generatedAt, now, now),
    env.DB.prepare(
      `INSERT INTO report_workflows (report_id, company_id, status, review_note, updated_by, updated_at)
       VALUES (?, ?, 'finalized', NULL, ?, ?)
       ON CONFLICT(report_id) DO NOTHING`,
    ).bind(reportId, device.company_id, device.id, now),
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

async function listSummary(env, company) {
  const [employees, reports, departments] = await Promise.all([
    env.DB.prepare(
      `SELECT e.id, e.display_name, e.department, e.status, MAX(d.last_seen_at) AS last_seen_at,
       COUNT(DISTINCT d.id) AS device_count, MAX(r.period_start) AS latest_period
       FROM company_employees ce JOIN employees e ON e.id=ce.employee_id
       LEFT JOIN company_devices cd ON cd.company_id=ce.company_id
       LEFT JOIN devices d ON d.id=cd.device_id AND d.employee_id=e.id
       LEFT JOIN company_reports cr ON cr.company_id=ce.company_id
       LEFT JOIN reports r ON r.id=cr.report_id AND r.employee_id=e.id
       WHERE ce.company_id=? GROUP BY e.id ORDER BY e.display_name`,
    ).bind(company.id).all(),
    env.DB.prepare(
      `SELECT r.id, r.employee_id, e.display_name, e.department, r.period_start, r.period_end,
       r.revision, r.generated_at, r.received_at, r.content_sha256, m.active_minutes,
       m.idle_minutes, m.categories_json FROM reports r
       JOIN company_reports cr ON cr.report_id=r.id
       JOIN employees e ON e.id=r.employee_id LEFT JOIN report_metrics m ON m.report_id=r.id
       WHERE cr.company_id=?
       ORDER BY r.period_start DESC, e.display_name LIMIT 200`,
    ).bind(company.id).all(),
    env.DB.prepare(
      `SELECT e.department, COUNT(*) AS count FROM company_employees ce
       JOIN employees e ON e.id=ce.employee_id WHERE ce.company_id=? GROUP BY e.department`,
    ).bind(company.id).all(),
  ]);
  return json({
    employees: employees.results,
    reports: reports.results.map((item) => ({
      ...item,
      categories: JSON.parse(item.categories_json || "[]"),
      categories_json: undefined,
    })),
    departments: departments.results,
    company: { id: company.id, name: company.name },
    refreshedAt: new Date().toISOString(),
  });
}

const decodeHtmlText = (value) => String(value || "")
  .replace(/<[^>]*>/g, " ")
  .replaceAll("&amp;", "&")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&quot;", '"')
  .replaceAll("&#39;", "'")
  .replace(/\s+/g, " ")
  .trim();

function categoriesFromReportHtml(html) {
  const categories = [];
  const pattern = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  for (const match of String(html || "").matchAll(pattern)) {
    const category = decodeHtmlText(match[1]);
    const minutes = Number.parseFloat(decodeHtmlText(match[2]).replaceAll(",", ""));
    if (category && Number.isFinite(minutes) && minutes >= 0) categories.push({ category, minutes });
  }
  return categories;
}

function normalizeCategories(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const category = String(item?.category || item?.name || item?.id || "").trim();
    const minutes = Number(item?.minutes ?? item?.activeMinutes ?? item?.value);
    return category && Number.isFinite(minutes) && minutes >= 0 ? [{ category, minutes }] : [];
  });
}

async function dashboardSummary(env, company) {
  const [employees, deviceSummary, deviceRows, reports, reportVersions, auditRows, settings,
    opportunityStates, classificationRules, privacyRequests, consentEvents] = await Promise.all([
    env.DB.prepare(
      `SELECT e.id, e.display_name, e.department, MAX(d.last_seen_at) AS last_seen_at
       FROM company_employees ce JOIN employees e ON e.id=ce.employee_id
       LEFT JOIN company_devices cd ON cd.company_id=ce.company_id
       LEFT JOIN devices d ON d.id=cd.device_id AND d.employee_id=e.id AND d.status='active'
       WHERE ce.company_id=? AND e.status='active'
       GROUP BY e.id, e.display_name, e.department ORDER BY e.display_name`,
    ).bind(company.id).all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count, MAX(d.last_seen_at) AS last_seen_at FROM company_devices cd
       JOIN devices d ON d.id=cd.device_id WHERE cd.company_id=? AND d.status='active'`,
    ).bind(company.id).first(),
    env.DB.prepare(
      `SELECT d.id, d.name, d.status, d.app_version, d.last_seen_at, d.created_at,
       e.id AS employee_id, e.display_name, e.department
       FROM company_devices cd JOIN devices d ON d.id=cd.device_id
       JOIN employees e ON e.id=d.employee_id WHERE cd.company_id=?
       ORDER BY COALESCE(d.last_seen_at, d.created_at) DESC`,
    ).bind(company.id).all(),
    env.DB.prepare(
      `SELECT r.id, r.employee_id, r.period_start, r.period_end, r.revision, r.generated_at,
       r.received_at, e.display_name, e.department, r.content_sha256,
       r.content_cipher, r.content_nonce, m.active_minutes, m.idle_minutes,
       m.capture_count, m.work_log_count, m.categories_json,
       COALESCE(w.status,'finalized') AS workflow_status, w.review_note, w.updated_at AS workflow_updated_at
       FROM company_reports cr JOIN reports r ON r.id=cr.report_id
       JOIN employees e ON e.id=r.employee_id
       LEFT JOIN report_metrics m ON m.report_id=r.id
       LEFT JOIN report_workflows w ON w.report_id=r.id AND w.company_id=cr.company_id
       WHERE cr.company_id=? AND e.status='active' ORDER BY r.period_start DESC LIMIT 200`,
    ).bind(company.id).all(),
    env.DB.prepare(
      `SELECT v.id, v.report_id, v.revision, v.content_sha256, v.generated_at, v.received_at
       FROM report_versions v JOIN company_reports cr ON cr.report_id=v.report_id
       WHERE cr.company_id=? ORDER BY v.report_id, v.revision DESC`,
    ).bind(company.id).all(),
    env.DB.prepare(
      `SELECT id, actor_type, actor_id, action, target_type, target_id, occurred_at, metadata_json
       FROM audit_events WHERE
       (target_type='company' AND target_id=?) OR
       (target_type='report' AND target_id IN (SELECT report_id FROM company_reports WHERE company_id=?)) OR
       (target_type='device' AND target_id IN (SELECT device_id FROM company_devices WHERE company_id=?))
       ORDER BY occurred_at DESC LIMIT 200`,
    ).bind(company.id, company.id, company.id).all(),
    env.DB.prepare("SELECT * FROM company_settings WHERE company_id=?").bind(company.id).first(),
    env.DB.prepare("SELECT * FROM opportunity_states WHERE company_id=? ORDER BY updated_at DESC")
      .bind(company.id).all(),
    env.DB.prepare("SELECT * FROM classification_rules WHERE company_id=? ORDER BY category")
      .bind(company.id).all(),
    env.DB.prepare("SELECT * FROM privacy_requests WHERE company_id=? ORDER BY requested_at DESC LIMIT 200")
      .bind(company.id).all(),
    env.DB.prepare("SELECT * FROM consent_events WHERE company_id=? ORDER BY occurred_at DESC LIMIT 200")
      .bind(company.id).all(),
  ]);
  const rows = [];
  let fallbackCount = 0;
  let reportsWithRows = 0;
  for (const report of reports.results) {
    let categories = normalizeCategories(JSON.parse(report.categories_json || "[]"));
    if (!categories.length) {
      const html = await decryptReport(env, report.content_cipher, report.content_nonce);
      categories = categoriesFromReportHtml(html);
      fallbackCount += Number(categories.length > 0);
    }
    reportsWithRows += Number(categories.length > 0);
    for (const item of categories) {
      rows.push({ periodStart: report.period_start, periodEnd: report.period_end,
        employeeId: report.employee_id, department: report.department,
        category: item.category, minutes: item.minutes });
    }
  }
  return json({
    source: "Cloudflare D1 / finalized weekly management reports",
    company: { id: company.id, name: company.name },
    refreshedAt: new Date().toISOString(),
    latestReceivedAt: reports.results[0]?.received_at || null,
    employeeCount: employees.results.length, employees: employees.results,
    devices: deviceRows.results, deviceCount: Number(deviceSummary?.count || 0),
    reportCount: reports.results.length, latestDeviceSyncAt: deviceSummary?.last_seen_at || null,
    reports: reports.results.map(({ content_cipher, content_nonce, categories_json, ...report }) => ({
      ...report, categories: normalizeCategories(JSON.parse(categories_json || "[]")), revision: Number(report.revision || 1),
      versions: reportVersions.results.filter((version) => version.report_id === report.id),
    })),
    auditEvents: auditRows.results.map((item) => ({ ...item,
      metadata: JSON.parse(item.metadata_json || "{}"), metadata_json: undefined })),
    settings: settings || { timezone: "Asia/Tokyo", week_start: 1,
      report_retention_days: 90, audit_retention_days: 365 },
    admin: { email: company.email },
    opportunityStates: opportunityStates.results,
    classificationRules: classificationRules.results,
    privacyRequests: privacyRequests.results,
    consentEvents: consentEvents.results,
    rows,
    quality: { reportsWithStructuredMetrics: reportsWithRows - fallbackCount,
      reportsParsedFromEncryptedContent: fallbackCount,
      reportsWithoutCategoryData: reports.results.length - reportsWithRows },
  });
}

async function reportContent(env, company, reportId) {
  const report = await env.DB.prepare(
    `SELECT r.content_cipher, r.content_nonce, r.content_sha256 FROM reports r
     JOIN company_reports cr ON cr.report_id=r.id WHERE r.id=? AND cr.company_id=?`,
  ).bind(reportId, company.id).first();
  if (!report) return json({ error: "not_found" }, 404);
  const html = await decryptReport(env, report.content_cipher, report.content_nonce);
  await audit(env, "admin", company.email, "report.viewed", "report", reportId);
  const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
  return json({ html, sha256: report.content_sha256, csp });
}

async function reportVersionContent(env, company, reportId, revision) {
  const report = await env.DB.prepare(
    `SELECT v.content_cipher, v.content_nonce, v.content_sha256 FROM report_versions v
     JOIN company_reports cr ON cr.report_id=v.report_id
     WHERE v.report_id=? AND v.revision=? AND cr.company_id=?`,
  ).bind(reportId, revision, company.id).first();
  if (!report) return json({ error: "not_found" }, 404);
  const html = await decryptReport(env, report.content_cipher, report.content_nonce);
  await audit(env, "admin", company.email, "report.version_viewed", "report", reportId, { revision });
  const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
  return json({ html, sha256: report.content_sha256, csp, revision });
}

const reportTransitions = {
  review_pending: ["finalized", "failed"],
  finalized: ["review_pending", "delivered", "failed"],
  failed: ["review_pending", "finalized"],
  delivered: [],
};

async function updateReportWorkflow(request, env, company, reportId) {
  const owned = await env.DB.prepare(
    "SELECT report_id FROM company_reports WHERE company_id=? AND report_id=?",
  ).bind(company.id, reportId).first();
  if (!owned) return json({ error: "not_found" }, 404);
  const body = await request.json();
  const nextStatus = String(body.status || "");
  const note = String(body.note || "").trim().slice(0, 1000);
  const current = await env.DB.prepare(
    "SELECT status FROM report_workflows WHERE company_id=? AND report_id=?",
  ).bind(company.id, reportId).first();
  const currentStatus = current?.status || "finalized";
  if (!reportTransitions[currentStatus]?.includes(nextStatus)) {
    return json({ error: "invalid_status_transition", currentStatus }, 409);
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO report_workflows VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(report_id) DO UPDATE SET status=excluded.status, review_note=excluded.review_note,
     updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
  ).bind(reportId, company.id, nextStatus, note || null, company.email, now).run();
  await audit(env, "admin", company.email, "report.status_changed", "report", reportId,
    { from: currentStatus, to: nextStatus, hasNote: Boolean(note) });
  return json({ ok: true, status: nextStatus, updatedAt: now });
}

async function updateOpportunityState(request, env, company) {
  const body = await request.json();
  const department = String(body.department || "").trim().slice(0, 128);
  const category = String(body.category || "").trim().slice(0, 128);
  const status = String(body.status || "new");
  const allowed = ["new", "reviewing", "planned", "poc", "implemented", "measuring", "rejected"];
  if (!department || !category || !allowed.includes(status)) return json({ error: "invalid_input" }, 400);
  const key = await sha256(`${department}\n${category}`);
  const owner = String(body.owner || "").trim().slice(0, 128);
  const nextAction = String(body.nextAction || "").trim().slice(0, 1000);
  const reason = String(body.decisionReason || "").trim().slice(0, 1000);
  if (["rejected", "implemented"].includes(status) && !reason) {
    return json({ error: "decision_reason_required" }, 400);
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO opportunity_states VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(company_id, opportunity_key) DO UPDATE SET status=excluded.status,
     owner=excluded.owner, next_action=excluded.next_action, decision_reason=excluded.decision_reason,
     updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
  ).bind(company.id, key, department, category, status, owner || null, nextAction || null,
    reason || null, company.email, now).run();
  await audit(env, "admin", company.email, "opportunity.updated", "company", company.id,
    { opportunityKey: key, department, category, status });
  return json({ ok: true, opportunityKey: key, status, updatedAt: now });
}

async function upsertClassificationRule(request, env, company) {
  const body = await request.json();
  const category = String(body.category || "").trim().slice(0, 128);
  const displayName = String(body.displayName || "").trim().slice(0, 128);
  const rate = Number(body.automationRate);
  const status = String(body.status || "active");
  if (!category || !displayName || !Number.isFinite(rate) || rate < 0 || rate > 1
      || !["active", "inactive"].includes(status)) return json({ error: "invalid_input" }, 400);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO classification_rules VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(company_id, category) DO UPDATE SET display_name=excluded.display_name,
     automation_rate=excluded.automation_rate, status=excluded.status,
     updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
  ).bind(company.id, category, displayName, rate, status, company.email, now).run();
  await audit(env, "admin", company.email, "classification_rule.updated", "company", company.id,
    { category, displayName, automationRate: rate, status });
  return json({ ok: true });
}

async function createPrivacyRequest(request, env, company) {
  const body = await request.json();
  const requestType = String(body.requestType || "");
  const subject = String(body.subject || "").trim().slice(0, 256);
  const reason = String(body.reason || "").trim().slice(0, 1000);
  if (!["export", "deletion", "correction"].includes(requestType) || !subject) {
    return json({ error: "invalid_input" }, 400);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO privacy_requests (id, company_id, request_type, subject, status, reason,
     requested_by, requested_at) VALUES (?, ?, ?, ?, 'requested', ?, ?, ?)`,
  ).bind(id, company.id, requestType, subject, reason || null, company.email, now).run();
  await audit(env, "admin", company.email, "privacy_request.created", "company", company.id,
    { requestId: id, requestType });
  return json({ id, status: "requested" }, 201);
}

async function updatePrivacyRequest(request, env, company, requestId) {
  const existing = await env.DB.prepare(
    "SELECT status FROM privacy_requests WHERE id=? AND company_id=?",
  ).bind(requestId, company.id).first();
  if (!existing) return json({ error: "not_found" }, 404);
  const body = await request.json();
  const status = String(body.status || "");
  const transitions = { requested: ["processing", "rejected"], processing: ["completed", "rejected"],
    completed: [], rejected: [] };
  if (!transitions[existing.status]?.includes(status)) return json({ error: "invalid_status_transition" }, 409);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE privacy_requests SET status=?, resolved_by=?, resolved_at=? WHERE id=? AND company_id=?",
  ).bind(status, ["completed", "rejected"].includes(status) ? company.email : null,
    ["completed", "rejected"].includes(status) ? now : null, requestId, company.id).run();
  await audit(env, "admin", company.email, "privacy_request.status_changed", "company", company.id,
    { requestId, from: existing.status, to: status });
  return json({ ok: true, status });
}

async function recordConsent(request, env, company) {
  const body = await request.json();
  const employeeId = String(body.employeeId || "").trim();
  const status = String(body.status || "");
  const source = String(body.source || "admin_record").trim().slice(0, 128);
  if (!["granted", "withdrawn"].includes(status)) return json({ error: "invalid_input" }, 400);
  if (employeeId) {
    const employee = await env.DB.prepare(
      "SELECT employee_id FROM company_employees WHERE company_id=? AND employee_id=?",
    ).bind(company.id, employeeId).first();
    if (!employee) return json({ error: "employee_not_found" }, 404);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO consent_events VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, company.id, employeeId || null, status, source, now, company.email).run();
  await audit(env, "admin", company.email, "consent.recorded", "company", company.id,
    { consentId: id, employeeId: employeeId || null, status });
  return json({ id, status }, 201);
}

async function runRetention(env) {
  await ensureSchema(env);
  const statements = [];
  const companies = await env.DB.prepare(
    `SELECT c.id, COALESCE(s.report_retention_days,90) AS report_days,
     COALESCE(s.audit_retention_days,365) AS audit_days FROM companies c
     LEFT JOIN company_settings s ON s.company_id=c.id`,
  ).all();
  for (const company of companies.results) {
    const reportCutoff = new Date(Date.now() - Number(company.report_days) * 86400 * 1000).toISOString();
    const auditCutoff = new Date(Date.now() - Number(company.audit_days) * 86400 * 1000).toISOString();
    const expired = await env.DB.prepare(
      `SELECT r.id FROM reports r JOIN company_reports cr ON cr.report_id=r.id
       WHERE cr.company_id=? AND r.received_at<? LIMIT 500`,
    ).bind(company.id, reportCutoff).all();
    statements.push(env.DB.prepare(
      `DELETE FROM audit_events WHERE occurred_at<? AND (
       (target_type='company' AND target_id=?) OR
       (target_type='report' AND target_id IN (SELECT report_id FROM company_reports WHERE company_id=?)) OR
       (target_type='device' AND target_id IN (SELECT device_id FROM company_devices WHERE company_id=?)))`,
    ).bind(auditCutoff, company.id, company.id, company.id));
    statements.push(env.DB.prepare(
      `DELETE FROM idempotency_keys WHERE created_at<? AND device_id IN
       (SELECT device_id FROM company_devices WHERE company_id=?)`,
    ).bind(reportCutoff, company.id));
    for (const row of expired.results) {
      statements.push(env.DB.prepare("DELETE FROM company_reports WHERE report_id=?").bind(row.id));
      statements.push(env.DB.prepare("DELETE FROM report_versions WHERE report_id=?").bind(row.id));
      statements.push(env.DB.prepare("DELETE FROM report_workflows WHERE report_id=?").bind(row.id));
      statements.push(env.DB.prepare("DELETE FROM report_metrics WHERE report_id=?").bind(row.id));
      statements.push(env.DB.prepare("DELETE FROM reports WHERE id=?").bind(row.id));
      statements.push(env.DB.prepare(
        "INSERT INTO audit_events VALUES (?, 'system', NULL, 'report.expired', 'company', ?, ?, ?)",
      ).bind(crypto.randomUUID(), company.id, new Date().toISOString(), JSON.stringify({ reportId: row.id })));
    }
  }
  statements.push(env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at<=?").bind(new Date().toISOString()));
  await env.DB.batch(statements);
}

async function adminApi(request, env, pathname) {
  const company = await requireAdmin(request, env);
  if (!company) return json({ error: "admin_auth_required" }, 401);
  if (request.method === "GET" && pathname === "/api/admin/summary") return listSummary(env, company);
  if (request.method === "POST" && pathname === "/api/admin/devices") {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return createDevice(request, env);
  }
  if (request.method === "PATCH" && pathname === "/api/admin/settings") {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    const body = await request.json();
    const timezone = String(body.timezone || "Asia/Tokyo");
    const weekStart = Number(body.weekStart);
    const reportDays = Number(body.reportRetentionDays);
    const auditDays = Number(body.auditRetentionDays);
    if (!/^[A-Za-z_]+\/[A-Za-z_+-]+$/.test(timezone) || ![0,1].includes(weekStart)
      || !Number.isInteger(reportDays) || reportDays < 30 || reportDays > 730
      || !Number.isInteger(auditDays) || auditDays < 90 || auditDays > 2555) {
      return json({ error: "invalid_settings" }, 400);
    }
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO company_settings VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id) DO UPDATE SET timezone=excluded.timezone, week_start=excluded.week_start,
       report_retention_days=excluded.report_retention_days,
       audit_retention_days=excluded.audit_retention_days, updated_at=excluded.updated_at`,
    ).bind(company.id, timezone, weekStart, reportDays, auditDays, now).run();
    await audit(env, "admin", company.email, "settings.updated", "company", company.id,
      { timezone, weekStart, reportDays, auditDays });
    return json({ ok: true });
  }
  if (request.method === "POST" && pathname === "/api/admin/audit") {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    const body = await request.json();
    if (!['analytics.exported'].includes(body.action)) return json({ error: "invalid_action" }, 400);
    await audit(env, "admin", company.email, body.action, "company", company.id);
    return json({ ok: true }, 201);
  }
  const workflowMatch = pathname.match(/^\/api\/admin\/reports\/([^/]+)\/workflow$/);
  if (request.method === "PATCH" && workflowMatch) {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return updateReportWorkflow(request, env, company, workflowMatch[1]);
  }
  const versionMatch = pathname.match(/^\/api\/admin\/reports\/([^/]+)\/versions\/(\d+)\/content$/);
  if (request.method === "GET" && versionMatch) {
    return reportVersionContent(env, company, versionMatch[1], Number(versionMatch[2]));
  }
  if (request.method === "POST" && pathname === "/api/admin/opportunities/state") {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return updateOpportunityState(request, env, company);
  }
  if (request.method === "PUT" && pathname === "/api/admin/classification-rules") {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return upsertClassificationRule(request, env, company);
  }
  if (request.method === "POST" && pathname === "/api/admin/privacy-requests") {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return createPrivacyRequest(request, env, company);
  }
  const privacyMatch = pathname.match(/^\/api\/admin\/privacy-requests\/([^/]+)$/);
  if (request.method === "PATCH" && privacyMatch) {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return updatePrivacyRequest(request, env, company, privacyMatch[1]);
  }
  if (request.method === "POST" && pathname === "/api/admin/consent-events") {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return recordConsent(request, env, company);
  }
  const contentMatch = pathname.match(/^\/api\/admin\/reports\/([^/]+)\/content$/);
  if (request.method === "GET" && contentMatch) return reportContent(env, company, contentMatch[1]);
  return json({ error: "not_found" }, 404);
}

const legacyPage = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Screen Capture Report</title><style>
:root{color-scheme:light;--ink:#18242c;--muted:#667780;--paper:#f4f6f3;--card:#fff;--line:#dce3dd;--green:#2f6b55;--green2:#dfece5;--amber:#b87824;--shadow:0 12px 34px rgba(24,36,44,.08)}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 Inter,"Segoe UI",sans-serif}.shell{display:grid;grid-template-columns:240px 1fr;min-height:100vh}.side{background:#183c32;color:#eff8f3;padding:28px 20px;position:sticky;top:0;height:100vh}.brand{font-size:18px;font-weight:750;letter-spacing:-.02em}.brand small{display:block;font-size:11px;opacity:.7;letter-spacing:.12em;text-transform:uppercase;margin-bottom:7px}.nav{margin-top:38px}.nav a{display:block;color:#d8e8e1;text-decoration:none;padding:10px 12px;border-radius:10px;margin:5px 0}.nav a.active,.nav a:hover{background:rgba(255,255,255,.1);color:white}.privacy{position:absolute;bottom:22px;left:20px;right:20px;font-size:11px;color:#b9d1c6;border-top:1px solid rgba(255,255,255,.14);padding-top:16px}.main{padding:34px clamp(22px,4vw,60px)}header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}.eyebrow{color:var(--green);font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}h1{font-size:30px;margin:5px 0 2px;letter-spacing:-.035em}p.sub{color:var(--muted);margin:0}.actions{display:flex;gap:9px}button,input{font:inherit}button{border:0;border-radius:10px;padding:10px 14px;background:var(--green);color:white;font-weight:650;cursor:pointer}button.ghost{background:white;color:var(--ink);border:1px solid var(--line)}.cards{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:14px;margin:28px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:var(--shadow)}.card .label{color:var(--muted);font-size:12px}.card strong{display:block;font-size:28px;margin-top:5px;letter-spacing:-.04em}.grid{display:grid;grid-template-columns:1.35fr .65fr;gap:16px}.panel{background:white;border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}.panel-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid var(--line)}.panel h2{font-size:16px;margin:0}.panel-body{padding:18px 20px}.filters{display:flex;gap:8px}.filters input{border:1px solid var(--line);background:#fafbf9;border-radius:9px;padding:8px 10px;min-width:190px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px 9px;border-bottom:1px solid #edf0ed;vertical-align:top}th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}tr[data-id]{cursor:pointer}tr[data-id]:hover{background:#f4f8f5}.pill{display:inline-flex;border-radius:999px;padding:3px 8px;background:var(--green2);color:var(--green);font-size:11px;font-weight:700}.employee{padding:12px 0;border-bottom:1px solid #edf0ed}.employee:last-child{border:0}.employee b{display:block}.employee small{color:var(--muted)}dialog{border:0;border-radius:18px;box-shadow:0 28px 80px rgba(0,0,0,.25);width:min(920px,92vw);padding:0}dialog::backdrop{background:rgba(11,25,21,.58)}.dialog-head{padding:18px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between}.dialog-body{padding:20px}iframe{width:100%;height:62vh;border:1px solid var(--line);border-radius:12px;background:white}.login{position:fixed;inset:0;display:grid;place-items:center;background:#15352d;z-index:5}.login-card{width:min(420px,90vw);background:white;border-radius:20px;padding:30px;box-shadow:0 24px 80px rgba(0,0,0,.3)}.login h2{margin:0 0 8px}.login input{width:100%;border:1px solid var(--line);border-radius:10px;padding:11px;margin:15px 0 10px}.error{color:#a33;font-size:12px}.device-form{display:grid;grid-template-columns:1fr 1fr;gap:10px}.device-form input{border:1px solid var(--line);border-radius:9px;padding:9px}.device-form button{grid-column:1/-1}.token{word-break:break-all;background:#eef4f0;padding:10px;border-radius:9px;font-family:monospace;font-size:12px}@media(max-width:900px){.shell{grid-template-columns:1fr}.side{display:none}.cards{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.main{padding:24px 16px}}@media(max-width:520px){.cards{grid-template-columns:1fr 1fr}header{display:block}.actions{margin-top:14px}.filters{display:none}}
</style></head><body><div id="login" class="login"><form id="loginForm" class="login-card"><div class="eyebrow">Owner access</div><h2>管理ダッシュボード</h2><p class="sub">管理者のメールアドレスとパスワードでログインします。</p><input id="adminEmail" type="email" autocomplete="username" placeholder="メールアドレス" required><input id="adminPassword" type="password" autocomplete="current-password" placeholder="パスワード" required><button type="submit">ダッシュボードを開く</button><p id="loginError" class="error"></p></form></div><div class="shell"><aside class="side"><div class="brand"><small>Workflow intelligence</small>Screen Capture Report</div><nav class="nav"><a class="active" href="#overview">概要</a><a href="#reports">週次レポート</a><a href="#devices">端末登録</a></nav><div class="privacy">管理者画面に生画像・本人日報・ウィンドウタイトルは保存されません。</div></aside><main class="main"><header><div><div class="eyebrow">Management overview</div><h1>業務改善レポート</h1><p class="sub" id="freshness">データを読み込んでいます</p></div><div class="actions"><button class="ghost" id="refresh">更新</button><button id="register">端末を登録</button></div></header><section class="cards"><div class="card"><span class="label">登録従業員</span><strong id="employeeCount">—</strong></div><div class="card"><span class="label">週次レポート</span><strong id="reportCount">—</strong></div><div class="card"><span class="label">同期済み端末</span><strong id="deviceCount">—</strong></div><div class="card"><span class="label">対象部署</span><strong id="departmentCount">—</strong></div></section><section class="grid"><div class="panel" id="reports"><div class="panel-head"><h2>最新の週次レポート</h2><div class="filters"><input id="search" placeholder="氏名・部署で絞り込み"></div></div><div class="panel-body"><table><thead><tr><th>従業員</th><th>対象週</th><th>受信日時</th><th>状態</th></tr></thead><tbody id="reportRows"><tr><td colspan="4">レポートはまだありません</td></tr></tbody></table></div></div><div><div class="panel"><div class="panel-head"><h2>従業員</h2></div><div class="panel-body" id="employees">登録なし</div></div><div class="panel" id="devices" style="margin-top:16px"><div class="panel-head"><h2>データ境界</h2></div><div class="panel-body"><p><span class="pill">端末内のみ</span> 本人日報・キャプチャ</p><p><span class="pill">管理Web</span> 確定済み週次管理レポート</p></div></div></div></section></main></div><dialog id="reportDialog"><div class="dialog-head"><div><b id="reportTitle">週次レポート</b><div class="sub" id="reportHash"></div></div><button class="ghost" data-close>閉じる</button></div><div class="dialog-body"><iframe id="reportFrame" sandbox=""></iframe></div></dialog><dialog id="deviceDialog"><div class="dialog-head"><b>端末を登録</b><button class="ghost" data-close>閉じる</button></div><div class="dialog-body"><form id="deviceForm" class="device-form"><input name="displayName" placeholder="従業員名" required><input name="department" placeholder="部署" required><input name="deviceName" placeholder="端末名" required><input name="employeeId" placeholder="既存従業員ID（任意）"><button type="submit">登録トークンを発行</button></form><div id="deviceTokenBox"></div></div></dialog><script>
let adminEmail=sessionStorage.getItem('scr-admin-email')||'';let adminPassword=sessionStorage.getItem('scr-admin-password')||'';let data={employees:[],reports:[],departments:[]};const qs=s=>document.querySelector(s);async function api(path,options={}){const headers={...(options.headers||{}),'x-admin-email':adminEmail,'x-admin-password':adminPassword};const response=await fetch(path,{...options,headers});if(response.status===401)throw new Error('unauthorized');if(!response.ok)throw new Error('request_failed_'+response.status);return response.json()}function formatDate(value){if(!value)return'—';return new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value))}function escapeHtml(value){const el=document.createElement('span');el.textContent=String(value??'');return el.innerHTML}function render(){qs('#employeeCount').textContent=data.employees.length;qs('#reportCount').textContent=data.reports.length;qs('#deviceCount').textContent=data.employees.reduce((sum,item)=>sum+Number(item.device_count||0),0);qs('#departmentCount').textContent=data.departments.length;qs('#freshness').textContent='最終更新 '+formatDate(data.refreshedAt);qs('#employees').innerHTML=data.employees.length?data.employees.map(item=>'<div class="employee"><b>'+escapeHtml(item.display_name)+'</b><small>'+escapeHtml(item.department)+' · 最新 '+escapeHtml(item.latest_period||'未同期')+'</small></div>').join(''):'登録なし';renderRows()}function renderRows(){const query=qs('#search').value.toLowerCase();const rows=data.reports.filter(item=>(item.display_name+' '+item.department).toLowerCase().includes(query));qs('#reportRows').innerHTML=rows.length?rows.map(item=>'<tr data-id="'+escapeHtml(item.id)+'"><td><b>'+escapeHtml(item.display_name)+'</b><br><small>'+escapeHtml(item.department)+'</small></td><td>'+escapeHtml(item.period_start)+'〜'+escapeHtml(item.period_end)+'</td><td>'+formatDate(item.received_at)+'</td><td><span class="pill">同期済み</span></td></tr>').join(''):'<tr><td colspan="4">該当するレポートはありません</td></tr>';document.querySelectorAll('tr[data-id]').forEach(row=>row.onclick=()=>openReport(row.dataset.id))}async function load(){data=await api('/api/admin/summary');render()}async function openReport(id){const item=data.reports.find(report=>report.id===id);const content=await api('/api/admin/reports/'+encodeURIComponent(id)+'/content');qs('#reportTitle').textContent=(item?.display_name||'')+' · '+(item?.period_start||'');qs('#reportHash').textContent='SHA-256 '+content.sha256;const csp='<meta http-equiv="Content-Security-Policy" content="'+content.csp.replaceAll('"','&quot;')+'">';qs('#reportFrame').srcdoc=csp+content.html;qs('#reportDialog').showModal()}qs('#loginForm').onsubmit=async event=>{event.preventDefault();adminEmail=qs('#adminEmail').value.trim();adminPassword=qs('#adminPassword').value;try{await load();sessionStorage.setItem('scr-admin-email',adminEmail);sessionStorage.setItem('scr-admin-password',adminPassword);qs('#login').style.display='none'}catch(error){qs('#loginError').textContent='メールアドレスまたはパスワードが正しくありません'}};qs('#refresh').onclick=()=>load();qs('#search').oninput=renderRows;qs('#register').onclick=()=>qs('#deviceDialog').showModal();document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>button.closest('dialog').close());qs('#deviceForm').onsubmit=async event=>{event.preventDefault();const form=new FormData(event.target);const payload=Object.fromEntries(form.entries());const result=await api('/api/admin/devices',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});qs('#deviceTokenBox').innerHTML='<p><b>このトークンは一度だけ表示されます。</b></p><div class="token">'+escapeHtml(result.deviceToken)+'</div>';await load()};if(adminEmail&&adminPassword)load().then(()=>qs('#login').style.display='none').catch(()=>{sessionStorage.removeItem('scr-admin-email');sessionStorage.removeItem('scr-admin-password')});
</script><script>
const registrationFetch=window.fetch.bind(window);let latestRegistration=null;
window.fetch=(input,init)=>{const response=registrationFetch(input,init);if(String(input)==='/api/admin/devices'&&init?.method==='POST'){latestRegistration=response.then(value=>value.clone().json())}return response};
document.querySelector('#deviceForm').addEventListener('submit',event=>{const department=new FormData(event.target).get('department');queueMicrotask(async()=>{const result=await latestRegistration;if(!result?.deviceToken)return;const provisioning={schema_version:1,admin_api_url:location.origin,employee_id:result.employeeId,department,device_token:result.deviceToken};const box=document.querySelector('#deviceTokenBox');box.insertAdjacentHTML('beforeend','<p><button id="downloadProvisioning" type="button">Windows登録ファイルをダウンロード</button></p><p class="sub">Windowsへ登録後、このファイルを安全に削除してください。</p>');document.querySelector('#downloadProvisioning').onclick=()=>{const blob=new Blob([JSON.stringify(provisioning,null,2)],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='screen-capture-report-'+result.deviceId+'.scr-provision.json';link.click();URL.revokeObjectURL(link.href)}})});
</script></body></html>`;

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        await ensureSchema(env);
        return login(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        await ensureSchema(env);
        return logout(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/auth/session") {
        await ensureSchema(env);
        const company = await requireAdmin(request, env);
        return company ? json({ company: { id: company.id, name: company.name }, email: company.email,
          csrfToken: company.csrfToken }) : json({ error: "admin_auth_required" }, 401);
      }
      if (url.pathname.startsWith("/api/admin/")) {
        await ensureSchema(env);
        return adminApi(request, env, url.pathname);
      }
      if (request.method === "POST" && url.pathname === "/api/v1/device/register") {
        await ensureSchema(env);
        return registerDevice(request, env);
      }
      if (
        request.method === "POST"
        && ["/api/device/reports", "/api/v1/device/reports/weekly-management"].includes(url.pathname)
      ) {
        await ensureSchema(env);
        return uploadReport(request, env);
      }
      if (url.pathname === "/api/health") return json({ ok: true, database: Boolean(env.DB) });
      if (request.method === "GET" && url.pathname === "/api/dashboard/summary") {
        await ensureSchema(env);
        const company = await requireAdmin(request, env);
        if (!company) return json({ error: "admin_auth_required" }, 401);
        return dashboardSummary(env, company);
      }
      if (request.method !== "GET" || !["/", "/admin"].includes(url.pathname)) {
        return json({ error: "not_found" }, 404);
      }
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

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

const base64UrlToBytes = (value) => base64ToBytes(String(value).replaceAll("-", "+")
  .replaceAll("_", "/").padEnd(Math.ceil(String(value).length / 4) * 4, "="));
const bytesToBase64Url = (value) => bytesToBase64(value).replaceAll("+", "-")
  .replaceAll("/", "_").replaceAll("=", "");

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

async function hashPassword(value) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iterations = 210000;
  const key = await crypto.subtle.importKey("raw", enc.encode(value), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return `pbkdf2_sha256$${iterations}$${bytesToBase64(salt)}$${hex(derived)}`;
}

async function verifyPassword(value, stored) {
  if (!String(stored).startsWith("pbkdf2_sha256$")) return timingSafeMatch(value, stored);
  const [, iterationsValue, saltValue, expected] = stored.split("$");
  const iterations = Number(iterationsValue);
  if (!Number.isInteger(iterations) || iterations < 100000 || !saltValue || !expected) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(value), "PBKDF2", false, ["deriveBits"]);
  const derived = hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256",
    salt: base64ToBytes(saltValue), iterations }, key, 256));
  if (derived.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < derived.length; index += 1) {
    difference |= derived.charCodeAt(index) ^ expected.charCodeAt(index);
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

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const base32Encode = (bytes) => {
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  return bits.match(/.{1,5}/g).map((chunk) =>
    base32Alphabet[Number.parseInt(chunk.padEnd(5, "0"), 2)]).join("");
};
const base32Decode = (value) => {
  const bits = [...String(value).toUpperCase().replace(/=|\s/g, "")]
    .map((character) => base32Alphabet.indexOf(character).toString(2).padStart(5, "0")).join("");
  return Uint8Array.from(bits.match(/.{8}/g) || [], (chunk) => Number.parseInt(chunk, 2));
};

async function encryptSecret(env, value) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await reportKey(env), enc.encode(value));
  return { cipher, nonce };
}

async function decryptSecret(env, cipher, nonce) {
  const value = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(nonce) },
    await reportKey(env), new Uint8Array(cipher));
  return dec.decode(value);
}

async function totp(secret, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 30000);
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey("raw", base32Decode(secret),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = digest[digest.length - 1] & 15;
  const value = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(value % 1000000).padStart(6, "0");
}

async function validTotp(secret, code) {
  if (!/^\d{6}$/.test(code)) return false;
  for (const offset of [-30000, 0, 30000]) if (await totp(secret, Date.now() + offset) === code) return true;
  return false;
}

async function verifyTotp(env, user, code) {
  if (!user.mfa_secret_cipher || !user.mfa_secret_nonce) return false;
  return validTotp(await decryptSecret(env, user.mfa_secret_cipher, user.mfa_secret_nonce), code);
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
  `CREATE TABLE IF NOT EXISTS admin_users (company_id TEXT NOT NULL, email TEXT NOT NULL,
    password_hash TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    mfa_secret_cipher BLOB, mfa_secret_nonce BLOB, mfa_enabled INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(company_id, email))`,
  `CREATE TABLE IF NOT EXISTS admin_mfa_enrollments (company_id TEXT NOT NULL, email TEXT NOT NULL,
    secret_cipher BLOB NOT NULL, secret_nonce BLOB NOT NULL, expires_at TEXT NOT NULL,
    PRIMARY KEY(company_id, email))`,
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
  `CREATE TABLE IF NOT EXISTS device_heartbeats (device_id TEXT NOT NULL, company_id TEXT NOT NULL,
    metric_date TEXT NOT NULL, app_version TEXT, collection_state TEXT NOT NULL,
    scheduled_count INTEGER NOT NULL, eligible_count INTEGER NOT NULL, captured_count INTEGER NOT NULL,
    failed_count INTEGER NOT NULL, missing_count INTEGER NOT NULL, analyzed_count INTEGER NOT NULL,
    analysis_failed_count INTEGER NOT NULL, pause_reasons_json TEXT NOT NULL DEFAULT '{}',
    policy_version INTEGER, received_at TEXT NOT NULL, PRIMARY KEY(device_id, metric_date))`,
  `CREATE TABLE IF NOT EXISTS collection_policies (company_id TEXT PRIMARY KEY, version INTEGER NOT NULL,
    collection_enabled INTEGER NOT NULL DEFAULT 1, excluded_apps_json TEXT NOT NULL DEFAULT '[]',
    excluded_url_patterns_json TEXT NOT NULL DEFAULT '[]', excluded_time_ranges_json TEXT NOT NULL DEFAULT '[]',
    purpose_text TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS classification_corrections (id TEXT PRIMARY KEY, company_id TEXT NOT NULL,
    report_id TEXT NOT NULL, from_category TEXT NOT NULL, to_category TEXT NOT NULL, minutes REAL NOT NULL,
    reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'applied', created_by TEXT NOT NULL,
    created_at TEXT NOT NULL, applied_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS privacy_request_targets (request_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS legal_holds (id TEXT PRIMARY KEY, company_id TEXT NOT NULL,
    target_type TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', created_by TEXT NOT NULL, created_at TEXT NOT NULL,
    released_by TEXT, released_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS deletion_receipts (id TEXT PRIMARY KEY, company_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE, target_type TEXT NOT NULL, target_id_hash TEXT NOT NULL,
    reports_deleted INTEGER NOT NULL, devices_deleted INTEGER NOT NULL, employees_deleted INTEGER NOT NULL,
    executed_by TEXT NOT NULL, executed_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS delivery_channels (id TEXT PRIMARY KEY, company_id TEXT NOT NULL,
    channel TEXT NOT NULL, destination_cipher BLOB NOT NULL, destination_nonce BLOB NOT NULL,
    destination_hint TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(company_id, channel))`,
  `CREATE TABLE IF NOT EXISTS report_deliveries (id TEXT PRIMARY KEY, company_id TEXT NOT NULL,
    report_id TEXT NOT NULL, channel TEXT NOT NULL, destination_hint TEXT NOT NULL,
    status TEXT NOT NULL, provider_reference TEXT, error_code TEXT, requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL, completed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS delivery_schedules (id TEXT PRIMARY KEY, company_id TEXT NOT NULL,
    channel TEXT NOT NULL, weekday INTEGER NOT NULL, hour INTEGER NOT NULL, timezone TEXT NOT NULL,
    human_review_required INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(company_id, channel))`,
  `CREATE TABLE IF NOT EXISTS oidc_configs (company_id TEXT PRIMARY KEY, issuer TEXT NOT NULL,
    client_id TEXT NOT NULL, client_secret_cipher BLOB NOT NULL, client_secret_nonce BLOB NOT NULL,
    allowed_domain TEXT, default_role TEXT NOT NULL DEFAULT 'manager', enabled INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS oidc_transactions (state_hash TEXT PRIMARY KEY, company_id TEXT NOT NULL,
    verifier_cipher BLOB NOT NULL, verifier_nonce BLOB NOT NULL, nonce_hash TEXT NOT NULL,
    redirect_uri TEXT NOT NULL, expires_at TEXT NOT NULL)`,
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
    `SELECT s.company_id, s.email, s.csrf_token, s.expires_at, c.name,
     COALESCE(u.role,'owner') AS role, COALESCE(u.status,'active') AS user_status
     FROM admin_sessions s JOIN companies c ON c.id=s.company_id
     LEFT JOIN admin_users u ON u.company_id=s.company_id AND u.email=s.email
     WHERE s.token_hash=? AND s.expires_at>? AND c.status='active'`,
  ).bind(await sha256(token), new Date().toISOString()).first();
  return session && session.user_status === "active" ? { id: session.company_id, name: session.name,
    email: session.email, role: session.role,
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
  let user = company ? await env.DB.prepare(
    "SELECT * FROM admin_users WHERE company_id=? AND email=?",
  ).bind(company.id, email).first() : null;
  if (company && !user && email === expectedEmail && await timingSafeMatch(password, expectedPasswordHash)) {
    const createdAt = now.toISOString();
    await env.DB.prepare(`INSERT INTO admin_users VALUES (?, ?, ?, 'owner', 'active',
      NULL, NULL, 0, ?, ?, ?)`)
      .bind(company.id, email, expectedPasswordHash, email, createdAt, createdAt).run();
    user = await env.DB.prepare("SELECT * FROM admin_users WHERE company_id=? AND email=?")
      .bind(company.id, email).first();
  }
  const credentialsValid = company && user?.status === "active"
    && await verifyPassword(password, user.password_hash);
  const mfaValid = !user?.mfa_enabled || await verifyTotp(env, user, String(body.otp || ""));
  if (!credentialsValid || !mfaValid) {
    await env.DB.prepare(
      `INSERT INTO admin_login_attempts VALUES (?, 1, ?)
       ON CONFLICT(attempt_key) DO UPDATE SET
       attempt_count=CASE WHEN window_started_at<? THEN 1 ELSE attempt_count+1 END,
       window_started_at=CASE WHEN window_started_at<? THEN excluded.window_started_at ELSE window_started_at END`,
    ).bind(attemptKey, now.toISOString(), new Date(now.getTime() - 15 * 60 * 1000).toISOString(),
      new Date(now.getTime() - 15 * 60 * 1000).toISOString()).run();
    return json({ error: credentialsValid && user?.mfa_enabled ? "mfa_required" : "invalid_credentials" }, 401);
  }
  if (!user.password_hash.startsWith("pbkdf2_sha256$")) {
    const upgraded = await hashPassword(password);
    await env.DB.prepare("UPDATE admin_users SET password_hash=?,updated_at=? WHERE company_id=? AND email=?")
      .bind(upgraded, now.toISOString(), company.id, email).run();
    user = { ...user, password_hash: upgraded };
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
  return json({ company: { id: company.id, name: company.name }, email, role: user.role,
    csrfToken, expiresAt }, 200,
    { "set-cookie": sessionCookie(token) });
}

const safeOidcUrl = (value) => {
  try {
    const url = new URL(value);
    const blocked = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)/i.test(url.hostname);
    return url.protocol === "https:" && !url.username && !url.password && !blocked ? url : null;
  } catch { return null; }
};

async function oidcDiscovery(issuer) {
  const base = safeOidcUrl(issuer);
  if (!base) throw new Error("invalid_oidc_issuer");
  const url = new URL(`${base.pathname.replace(/\/$/, "")}/.well-known/openid-configuration`, base.origin);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("oidc_discovery_failed");
  const discovery = await response.json();
  if (String(discovery.issuer).replace(/\/$/, "") !== String(issuer).replace(/\/$/, "")
    || !safeOidcUrl(discovery.authorization_endpoint) || !safeOidcUrl(discovery.token_endpoint)
    || !safeOidcUrl(discovery.jwks_uri)) throw new Error("invalid_oidc_discovery");
  return discovery;
}

async function verifyOidcIdToken(idToken, discovery, clientId, expectedNonceHash) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("invalid_id_token");
  const header = JSON.parse(dec.decode(base64UrlToBytes(parts[0])));
  const claims = JSON.parse(dec.decode(base64UrlToBytes(parts[1])));
  if (header.alg !== "RS256" || !header.kid) throw new Error("unsupported_id_token");
  const jwksResponse = await fetch(discovery.jwks_uri, { headers: { accept: "application/json" } });
  if (!jwksResponse.ok) throw new Error("jwks_fetch_failed");
  const jwk = (await jwksResponse.json()).keys?.find((item) => item.kid === header.kid
    && item.kty === "RSA" && (!item.use || item.use === "sig"));
  if (!jwk) throw new Error("signing_key_not_found");
  const key = await crypto.subtle.importKey("jwk", jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlToBytes(parts[2]),
    enc.encode(`${parts[0]}.${parts[1]}`));
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const now = Math.floor(Date.now() / 1000);
  if (!valid || claims.iss !== discovery.issuer || !audience.includes(clientId)
    || (audience.length > 1 && claims.azp !== clientId) || Number(claims.exp) <= now
    || Number(claims.iat || 0) > now + 60 || await sha256(String(claims.nonce || "")) !== expectedNonceHash
    || !claims.sub || !claims.email || claims.email_verified === false) throw new Error("invalid_id_token_claims");
  return claims;
}

async function configureOidc(request, env, company) {
  const body = await request.json(), issuer = String(body.issuer || "").trim().replace(/\/$/, "");
  const clientId = String(body.clientId || "").trim().slice(0, 512);
  const clientSecret = String(body.clientSecret || "").trim();
  const allowedDomain = String(body.allowedDomain || "").trim().toLowerCase().replace(/^@/, "");
  const defaultRole = String(body.defaultRole || "manager"), enabled = body.enabled !== false;
  if (!safeOidcUrl(issuer) || !clientId || !clientSecret || clientSecret.length > 2048
    || (allowedDomain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(allowedDomain))
    || !["manager", "auditor"].includes(defaultRole)) return json({ error: "invalid_oidc_config" }, 400);
  await oidcDiscovery(issuer);
  const encrypted = await encryptSecret(env, clientSecret), now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO oidc_configs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id) DO UPDATE SET issuer=excluded.issuer,client_id=excluded.client_id,
    client_secret_cipher=excluded.client_secret_cipher,client_secret_nonce=excluded.client_secret_nonce,
    allowed_domain=excluded.allowed_domain,default_role=excluded.default_role,enabled=excluded.enabled,
    updated_by=excluded.updated_by,updated_at=excluded.updated_at`).bind(company.id, issuer, clientId,
    encrypted.cipher, encrypted.nonce, allowedDomain || null, defaultRole, Number(enabled), company.email, now).run();
  await audit(env, "admin", company.email, "oidc.updated", "company", company.id,
    { issuer, allowedDomain: allowedDomain || null, defaultRole, enabled });
  return json({ ok: true, issuer, clientId, allowedDomain: allowedDomain || null, defaultRole, enabled });
}

async function startOidc(request, env) {
  const url = new URL(request.url), company = await companyByCode(env, url.searchParams.get("companyCode") || "");
  if (!company) return json({ error: "sso_not_configured" }, 404);
  const config = await env.DB.prepare("SELECT * FROM oidc_configs WHERE company_id=? AND enabled=1")
    .bind(company.id).first();
  if (!config) return json({ error: "sso_not_configured" }, 404);
  const discovery = await oidcDiscovery(config.issuer), state = randomToken(32), nonce = randomToken(24);
  const verifier = randomToken(48), encrypted = await encryptSecret(env, verifier);
  const challenge = bytesToBase64Url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  const redirectUri = `${url.origin}/api/auth/oidc/callback`;
  await env.DB.prepare("INSERT INTO oidc_transactions VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(await sha256(state), company.id, encrypted.cipher, encrypted.nonce, await sha256(nonce),
      redirectUri, new Date(Date.now() + 10 * 60 * 1000).toISOString()).run();
  const authorization = new URL(discovery.authorization_endpoint);
  Object.entries({ response_type: "code", client_id: config.client_id, redirect_uri: redirectUri,
    scope: "openid email profile", state, nonce, code_challenge: challenge,
    code_challenge_method: "S256" }).forEach(([key, value]) => authorization.searchParams.set(key, value));
  return Response.redirect(authorization.toString(), 302);
}

async function oidcCallback(request, env) {
  const url = new URL(request.url), state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const transaction = state ? await env.DB.prepare(`SELECT t.*,c.name FROM oidc_transactions t
    JOIN companies c ON c.id=t.company_id WHERE t.state_hash=? AND t.expires_at>?`)
    .bind(await sha256(state), new Date().toISOString()).first() : null;
  const failure = (reason) => Response.redirect(`${url.origin}/?sso_error=${encodeURIComponent(reason)}`, 302);
  if (!transaction || !code) return failure("invalid_sso_response");
  await env.DB.prepare("DELETE FROM oidc_transactions WHERE state_hash=?").bind(await sha256(state)).run();
  try {
    const config = await env.DB.prepare("SELECT * FROM oidc_configs WHERE company_id=? AND enabled=1")
      .bind(transaction.company_id).first();
    if (!config) return failure("sso_not_configured");
    const discovery = await oidcDiscovery(config.issuer);
    const verifier = await decryptSecret(env, transaction.verifier_cipher, transaction.verifier_nonce);
    const secret = await decryptSecret(env, config.client_secret_cipher, config.client_secret_nonce);
    const tokenResponse = await fetch(discovery.token_endpoint, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code,
        redirect_uri: transaction.redirect_uri, client_id: config.client_id,
        client_secret: secret, code_verifier: verifier }) });
    if (!tokenResponse.ok) return failure("sso_token_exchange_failed");
    const tokens = await tokenResponse.json();
    const claims = await verifyOidcIdToken(tokens.id_token, discovery, config.client_id, transaction.nonce_hash);
    const email = String(claims.email).trim().toLowerCase();
    if (config.allowed_domain && !email.endsWith(`@${config.allowed_domain}`)) return failure("sso_domain_not_allowed");
    let user = await env.DB.prepare("SELECT * FROM admin_users WHERE company_id=? AND email=?")
      .bind(transaction.company_id, email).first();
    const now = new Date(), company = { id: transaction.company_id, name: transaction.name };
    if (!user) {
      const createdAt = now.toISOString();
      await env.DB.prepare(`INSERT INTO admin_users VALUES (?, ?, ?, ?, 'active', NULL, NULL, 0,
        'oidc', ?, ?)`).bind(company.id, email, await hashPassword(randomToken(48)),
        config.default_role, createdAt, createdAt).run();
      user = await env.DB.prepare("SELECT * FROM admin_users WHERE company_id=? AND email=?")
        .bind(company.id, email).first();
    }
    if (user.status !== "active") return failure("sso_user_suspended");
    const token = randomToken(), csrfToken = randomToken(24);
    const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare("INSERT INTO admin_sessions VALUES (?, ?, ?, ?, ?, ?)")
      .bind(await sha256(token), company.id, email, csrfToken, now.toISOString(), expiresAt).run();
    await audit(env, "admin", email, "session.login", "company", company.id, { method: "oidc" });
    return new Response(null, { status: 302, headers: { location: `${url.origin}/`,
      "set-cookie": sessionCookie(token), "cache-control": "no-store" } });
  } catch { return failure("sso_verification_failed"); }
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

function boundedCount(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 1000000 ? number : null;
}

async function receiveHeartbeat(request, env) {
  const device = await requireDevice(request, env);
  if (!device) return json({ error: "invalid_device_token" }, 401);
  const body = await request.json();
  const metricDate = String(body.metric_date || body.metricDate || "");
  const state = String(body.collection_state || body.collectionState || "");
  const allowedStates = ["active", "paused", "offline", "error", "disabled"];
  const fields = ["scheduled_count", "eligible_count", "captured_count", "failed_count",
    "missing_count", "analyzed_count", "analysis_failed_count"];
  const counts = Object.fromEntries(fields.map((key) => [key,
    boundedCount(body[key] ?? body[key.replace(/_([a-z])/g, (_m, c) => c.toUpperCase())])]));
  const pauseReasons = body.pause_reasons ?? body.pauseReasons ?? {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(metricDate) || !allowedStates.includes(state)
    || Object.values(counts).some((value) => value === null)
    || !pauseReasons || Array.isArray(pauseReasons) || typeof pauseReasons !== "object"
    || Object.keys(pauseReasons).length > 20
    || Object.values(pauseReasons).some((value) => boundedCount(value) === null)) {
    return json({ error: "invalid_heartbeat" }, 400);
  }
  const appVersion = String(body.app_version || body.appVersion || "").slice(0, 64) || null;
  const policyVersion = body.policy_version == null && body.policyVersion == null ? null
    : boundedCount(body.policy_version ?? body.policyVersion);
  if ((body.policy_version != null || body.policyVersion != null) && policyVersion === null) {
    return json({ error: "invalid_policy_version" }, 400);
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO device_heartbeats VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, metric_date) DO UPDATE SET app_version=excluded.app_version,
      collection_state=excluded.collection_state, scheduled_count=excluded.scheduled_count,
      eligible_count=excluded.eligible_count, captured_count=excluded.captured_count,
      failed_count=excluded.failed_count, missing_count=excluded.missing_count,
      analyzed_count=excluded.analyzed_count, analysis_failed_count=excluded.analysis_failed_count,
      pause_reasons_json=excluded.pause_reasons_json, policy_version=excluded.policy_version,
      received_at=excluded.received_at`).bind(device.id, device.company_id, metricDate, appVersion, state,
      counts.scheduled_count, counts.eligible_count, counts.captured_count, counts.failed_count,
      counts.missing_count, counts.analyzed_count, counts.analysis_failed_count,
      JSON.stringify(pauseReasons), policyVersion, now),
    env.DB.prepare("UPDATE devices SET last_seen_at=?, app_version=COALESCE(?,app_version) WHERE id=?")
      .bind(now, appVersion, device.id),
  ]);
  return json({ ok: true, receivedAt: now });
}

async function devicePolicy(request, env) {
  const device = await requireDevice(request, env);
  if (!device) return json({ error: "invalid_device_token" }, 401);
  const policy = await env.DB.prepare("SELECT * FROM collection_policies WHERE company_id=?")
    .bind(device.company_id).first();
  return json(policy ? { version: Number(policy.version), collectionEnabled: Boolean(policy.collection_enabled),
    excludedApps: JSON.parse(policy.excluded_apps_json),
    excludedUrlPatterns: JSON.parse(policy.excluded_url_patterns_json),
    excludedTimeRanges: JSON.parse(policy.excluded_time_ranges_json), purposeText: policy.purpose_text,
    updatedAt: policy.updated_at } : { version: 0, collectionEnabled: true, excludedApps: [],
    excludedUrlPatterns: [], excludedTimeRanges: [], purposeText: "", updatedAt: null });
}

async function updateCollectionPolicy(request, env, company) {
  const body = await request.json();
  const arrays = [body.excludedApps, body.excludedUrlPatterns, body.excludedTimeRanges];
  if (typeof body.collectionEnabled !== "boolean" || arrays.some((items) => !Array.isArray(items)
    || items.length > 100 || items.some((item) => typeof item !== "string" || item.length > 256))) {
    return json({ error: "invalid_policy" }, 400);
  }
  const purposeText = String(body.purposeText || "").trim();
  if (purposeText.length > 2000) return json({ error: "invalid_policy" }, 400);
  const current = await env.DB.prepare("SELECT version FROM collection_policies WHERE company_id=?")
    .bind(company.id).first();
  const version = Number(current?.version || 0) + 1;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO collection_policies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id) DO UPDATE SET version=excluded.version,
    collection_enabled=excluded.collection_enabled, excluded_apps_json=excluded.excluded_apps_json,
    excluded_url_patterns_json=excluded.excluded_url_patterns_json,
    excluded_time_ranges_json=excluded.excluded_time_ranges_json, purpose_text=excluded.purpose_text,
    updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
    .bind(company.id, version, Number(body.collectionEnabled), JSON.stringify(body.excludedApps),
      JSON.stringify(body.excludedUrlPatterns), JSON.stringify(body.excludedTimeRanges), purposeText,
      company.email, now).run();
  await audit(env, "admin", company.email, "collection_policy.updated", "company", company.id,
    { version, collectionEnabled: body.collectionEnabled, excludedAppCount: body.excludedApps.length,
      excludedUrlCount: body.excludedUrlPatterns.length, excludedTimeRangeCount: body.excludedTimeRanges.length });
  return json({ ok: true, version });
}

async function dashboardSummary(env, company) {
  const [employees, deviceSummary, deviceRows, reports, reportVersions, auditRows, settings,
    opportunityStates, classificationRules, privacyRequests, consentEvents, deviceHeartbeats,
    collectionPolicy, classificationCorrections, legalHolds, privacyTargets,
    deletionReceipts, adminUsers, adminSessionCounts, deliveryChannels, reportDeliveries,
    deliverySchedules, oidcConfig] = await Promise.all([
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
    env.DB.prepare(`SELECT h.*, d.name AS device_name, e.display_name, e.department
      FROM device_heartbeats h JOIN devices d ON d.id=h.device_id
      JOIN employees e ON e.id=d.employee_id WHERE h.company_id=?
      ORDER BY h.metric_date DESC, h.received_at DESC LIMIT 1000`).bind(company.id).all(),
    env.DB.prepare("SELECT * FROM collection_policies WHERE company_id=?").bind(company.id).first(),
    env.DB.prepare("SELECT * FROM classification_corrections WHERE company_id=? ORDER BY created_at DESC LIMIT 500")
      .bind(company.id).all(),
    env.DB.prepare("SELECT * FROM legal_holds WHERE company_id=? ORDER BY created_at DESC LIMIT 200")
      .bind(company.id).all(),
    env.DB.prepare("SELECT * FROM privacy_request_targets WHERE company_id=?").bind(company.id).all(),
    env.DB.prepare("SELECT * FROM deletion_receipts WHERE company_id=? ORDER BY executed_at DESC LIMIT 200")
      .bind(company.id).all(),
    env.DB.prepare(`SELECT email,role,status,mfa_enabled,created_at,updated_at FROM admin_users
      WHERE company_id=? ORDER BY email`).bind(company.id).all(),
    env.DB.prepare(`SELECT email,COUNT(*) AS session_count,MAX(created_at) AS latest_session_at,
      MAX(expires_at) AS latest_expiry FROM admin_sessions WHERE company_id=? GROUP BY email`)
      .bind(company.id).all(),
    env.DB.prepare(`SELECT id,channel,destination_hint,enabled,created_at,updated_at
      FROM delivery_channels WHERE company_id=? ORDER BY channel`).bind(company.id).all(),
    env.DB.prepare(`SELECT * FROM report_deliveries WHERE company_id=?
      ORDER BY requested_at DESC LIMIT 200`).bind(company.id).all(),
    env.DB.prepare("SELECT * FROM delivery_schedules WHERE company_id=? ORDER BY channel")
      .bind(company.id).all(),
    env.DB.prepare(`SELECT issuer,client_id,allowed_domain,default_role,enabled,updated_at
      FROM oidc_configs WHERE company_id=?`).bind(company.id).first(),
  ]);
  const rows = [];
  const correctedCategories = new Map();
  let fallbackCount = 0;
  let reportsWithRows = 0;
  for (const report of reports.results) {
    let categories = normalizeCategories(JSON.parse(report.categories_json || "[]"));
    if (!categories.length) {
      const html = await decryptReport(env, report.content_cipher, report.content_nonce);
      categories = categoriesFromReportHtml(html);
      fallbackCount += Number(categories.length > 0);
    }
    for (const correction of classificationCorrections.results
      .filter((item) => item.report_id === report.id && item.status === "applied").reverse()) {
      const source = categories.find((item) => item.category === correction.from_category);
      const amount = Math.min(Number(correction.minutes), Number(source?.minutes || 0));
      if (source && amount > 0) {
        source.minutes -= amount;
        const target = categories.find((item) => item.category === correction.to_category);
        if (target) target.minutes += amount;
        else categories.push({ category: correction.to_category, minutes: amount });
      }
    }
    categories = categories.filter((item) => item.minutes > 0);
    correctedCategories.set(report.id, categories);
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
      ...report, categories: correctedCategories.get(report.id) || normalizeCategories(JSON.parse(categories_json || "[]")),
      revision: Number(report.revision || 1),
      reaggregationVersion: 1 + classificationCorrections.results.filter(
        (item) => item.report_id === report.id && item.status === "applied").length,
      versions: reportVersions.results.filter((version) => version.report_id === report.id),
    })),
    auditEvents: company.role === "manager" ? [] : auditRows.results.map((item) => ({ ...item,
      metadata: JSON.parse(item.metadata_json || "{}"), metadata_json: undefined })),
    settings: settings || { timezone: "Asia/Tokyo", week_start: 1,
      report_retention_days: 90, audit_retention_days: 365 },
    admin: { email: company.email, role: company.role },
    opportunityStates: opportunityStates.results,
    classificationRules: classificationRules.results,
    privacyRequests: company.role === "manager" ? [] : privacyRequests.results,
    consentEvents: company.role === "manager" ? [] : consentEvents.results,
    deviceHeartbeats: deviceHeartbeats.results.map((item) => ({ ...item,
      pause_reasons: JSON.parse(item.pause_reasons_json || "{}"), pause_reasons_json: undefined })),
    collectionPolicy: collectionPolicy ? { version: Number(collectionPolicy.version),
      collectionEnabled: Boolean(collectionPolicy.collection_enabled),
      excludedApps: JSON.parse(collectionPolicy.excluded_apps_json),
      excludedUrlPatterns: JSON.parse(collectionPolicy.excluded_url_patterns_json),
      excludedTimeRanges: JSON.parse(collectionPolicy.excluded_time_ranges_json),
      purposeText: collectionPolicy.purpose_text, updatedAt: collectionPolicy.updated_at } :
      { version: 0, collectionEnabled: true, excludedApps: [], excludedUrlPatterns: [],
        excludedTimeRanges: [], purposeText: "", updatedAt: null },
    classificationCorrections: classificationCorrections.results,
    legalHolds: company.role === "manager" ? [] : legalHolds.results,
    privacyRequestTargets: company.role === "manager" ? [] : privacyTargets.results,
    deletionReceipts: company.role === "manager" ? [] : deletionReceipts.results,
    adminUsers: adminUsers.results.map((user) => ({ ...user,
      mfa_enabled: Boolean(user.mfa_enabled), ...(adminSessionCounts.results.find(
        (session) => session.email === user.email) || { session_count: 0 }) })),
    deliveryChannels: deliveryChannels.results.map((item) => ({ ...item, enabled: Boolean(item.enabled),
      available: item.channel !== "email" || Boolean(env.EMAIL && env.REPORT_EMAIL_FROM) })),
    reportDeliveries: reportDeliveries.results,
    deliverySchedules: deliverySchedules.results.map((item) => ({ ...item,
      enabled: Boolean(item.enabled), human_review_required: Boolean(item.human_review_required) })),
    oidcConfig: oidcConfig ? { issuer: oidcConfig.issuer, clientId: oidcConfig.client_id,
      allowedDomain: oidcConfig.allowed_domain, defaultRole: oidcConfig.default_role,
      enabled: Boolean(oidcConfig.enabled), updatedAt: oidcConfig.updated_at } : null,
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

async function createClassificationCorrection(request, env, company) {
  const body = await request.json();
  const reportId = String(body.reportId || "").trim();
  const fromCategory = String(body.fromCategory || "").trim().slice(0, 128);
  const toCategory = String(body.toCategory || "").trim().slice(0, 128);
  const minutes = Number(body.minutes);
  const reason = String(body.reason || "").trim().slice(0, 1000);
  if (!reportId || !fromCategory || !toCategory || fromCategory === toCategory
    || !Number.isFinite(minutes) || minutes <= 0 || !reason) {
    return json({ error: "invalid_correction" }, 400);
  }
  const report = await env.DB.prepare(`SELECT m.categories_json, r.content_cipher, r.content_nonce
    FROM reports r JOIN company_reports cr ON cr.report_id=r.id
    LEFT JOIN report_metrics m ON m.report_id=r.id WHERE r.id=? AND cr.company_id=?`)
    .bind(reportId, company.id).first();
  if (!report) return json({ error: "report_not_found" }, 404);
  let categories = normalizeCategories(JSON.parse(report.categories_json || "[]"));
  if (!categories.length) {
    categories = categoriesFromReportHtml(await decryptReport(env, report.content_cipher, report.content_nonce));
  }
  const available = categories
    .find((item) => item.category === fromCategory)?.minutes || 0;
  const moved = await env.DB.prepare(`SELECT COALESCE(SUM(minutes),0) AS total, COUNT(*) AS count
    FROM classification_corrections WHERE company_id=? AND report_id=?
    AND from_category=? AND status='applied'`).bind(company.id, reportId, fromCategory).first();
  if (minutes > available - Number(moved?.total || 0)) {
    return json({ error: "correction_exceeds_available_minutes" }, 409);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO classification_corrections VALUES (?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?)")
    .bind(id, company.id, reportId, fromCategory, toCategory, minutes, reason, company.email, now, now).run();
  await audit(env, "admin", company.email, "classification.corrected", "report", reportId,
    { correctionId: id, fromCategory, toCategory, minutes, reasonLength: reason.length });
  return json({ id, status: "applied", reaggregationVersion: Number(moved?.count || 0) + 2 }, 201);
}

async function createPrivacyRequest(request, env, company) {
  const body = await request.json();
  const requestType = String(body.requestType || "");
  const subject = String(body.subject || "").trim().slice(0, 256);
  const reason = String(body.reason || "").trim().slice(0, 1000);
  const targetType = String(body.targetType || "").trim();
  const targetId = String(body.targetId || "").trim();
  if (!["export", "deletion", "correction"].includes(requestType) || !subject) {
    return json({ error: "invalid_input" }, 400);
  }
  if (targetType || targetId) {
    if (!["company", "employee", "report"].includes(targetType) || !targetId
      || (targetType === "company" && targetId !== company.id)) {
      return json({ error: "invalid_target" }, 400);
    }
    if (targetType !== "company") {
      const table = targetType === "employee" ? "company_employees" : "company_reports";
      const column = targetType === "employee" ? "employee_id" : "report_id";
      const owned = await env.DB.prepare(`SELECT ${column} AS id FROM ${table} WHERE company_id=? AND ${column}=?`)
        .bind(company.id, targetId).first();
      if (!owned) return json({ error: "target_not_found" }, 404);
    }
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const statements = [env.DB.prepare(
    `INSERT INTO privacy_requests (id, company_id, request_type, subject, status, reason,
     requested_by, requested_at) VALUES (?, ?, ?, ?, 'requested', ?, ?, ?)`,
  ).bind(id, company.id, requestType, subject, reason || null, company.email, now)];
  if (targetType) statements.push(env.DB.prepare("INSERT INTO privacy_request_targets VALUES (?, ?, ?, ?)")
    .bind(id, company.id, targetType, targetId));
  await env.DB.batch(statements);
  await audit(env, "admin", company.email, "privacy_request.created", "company", company.id,
    { requestId: id, requestType, targetType: targetType || null });
  return json({ id, status: "requested" }, 201);
}

async function createLegalHold(request, env, company) {
  const body = await request.json();
  const targetType = String(body.targetType || "");
  const targetId = String(body.targetId || "").trim();
  const reason = String(body.reason || "").trim().slice(0, 1000);
  if (!["company", "employee", "report"].includes(targetType) || !targetId || !reason
    || (targetType === "company" && targetId !== company.id)) return json({ error: "invalid_hold" }, 400);
  if (targetType !== "company") {
    const table = targetType === "employee" ? "company_employees" : "company_reports";
    const column = targetType === "employee" ? "employee_id" : "report_id";
    if (!await env.DB.prepare(`SELECT ${column} FROM ${table} WHERE company_id=? AND ${column}=?`)
      .bind(company.id, targetId).first()) return json({ error: "target_not_found" }, 404);
  }
  const id = crypto.randomUUID(), now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO legal_holds VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL)")
    .bind(id, company.id, targetType, targetId, reason, company.email, now).run();
  await audit(env, "admin", company.email, "legal_hold.created", "company", company.id,
    { holdId: id, targetType, targetIdHash: await sha256(targetId) });
  return json({ id, status: "active" }, 201);
}

async function releaseLegalHold(env, company, holdId) {
  const hold = await env.DB.prepare("SELECT status FROM legal_holds WHERE id=? AND company_id=?")
    .bind(holdId, company.id).first();
  if (!hold) return json({ error: "not_found" }, 404);
  if (hold.status !== "active") return json({ error: "hold_not_active" }, 409);
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE legal_holds SET status='released', released_by=?, released_at=? WHERE id=? AND company_id=?")
    .bind(company.email, now, holdId, company.id).run();
  await audit(env, "admin", company.email, "legal_hold.released", "company", company.id, { holdId });
  return json({ ok: true, status: "released" });
}

async function executeDeletionRequest(env, company, requestId) {
  const item = await env.DB.prepare(`SELECT p.request_type, p.status, t.target_type, t.target_id
    FROM privacy_requests p JOIN privacy_request_targets t ON t.request_id=p.id AND t.company_id=p.company_id
    WHERE p.id=? AND p.company_id=?`).bind(requestId, company.id).first();
  if (!item) return json({ error: "targeted_request_not_found" }, 404);
  if (item.request_type !== "deletion" || item.status !== "processing") {
    return json({ error: "request_not_executable" }, 409);
  }
  const hold = await env.DB.prepare(`SELECT id FROM legal_holds WHERE company_id=? AND status='active' AND
    ((target_type='company' AND target_id=?) OR (target_type=? AND target_id=?)) LIMIT 1`)
    .bind(company.id, company.id, item.target_type, item.target_id).first();
  if (hold) return json({ error: "legal_hold_active", holdId: hold.id }, 409);
  const reportIds = item.target_type === "report" ? [{ id: item.target_id }] :
    (await env.DB.prepare(`SELECT r.id FROM reports r JOIN company_reports cr ON cr.report_id=r.id
      WHERE cr.company_id=? AND (?='company' OR r.employee_id=?)`)
      .bind(company.id, item.target_type, item.target_id).all()).results;
  const devices = ["employee", "company"].includes(item.target_type) ? (await env.DB.prepare(`SELECT d.id FROM devices d
    JOIN company_devices cd ON cd.device_id=d.id WHERE cd.company_id=? AND (?='company' OR d.employee_id=?)`)
    .bind(company.id, item.target_type, item.target_id).all()).results : [];
  const employeeIds = item.target_type === "company" ? (await env.DB.prepare(
    "SELECT employee_id AS id FROM company_employees WHERE company_id=?",
  ).bind(company.id).all()).results : item.target_type === "employee" ? [{ id: item.target_id }] : [];
  const statements = [];
  for (const report of reportIds) statements.push(
    env.DB.prepare("DELETE FROM report_versions WHERE report_id=?").bind(report.id),
    env.DB.prepare("DELETE FROM report_workflows WHERE report_id=? AND company_id=?").bind(report.id, company.id),
    env.DB.prepare("DELETE FROM classification_corrections WHERE report_id=? AND company_id=?").bind(report.id, company.id),
    env.DB.prepare("DELETE FROM report_metrics WHERE report_id=?").bind(report.id),
    env.DB.prepare("DELETE FROM company_reports WHERE report_id=? AND company_id=?").bind(report.id, company.id),
    env.DB.prepare("DELETE FROM reports WHERE id=?").bind(report.id));
  if (["employee", "company"].includes(item.target_type)) {
    for (const device of devices) statements.push(
      env.DB.prepare("DELETE FROM device_heartbeats WHERE device_id=? AND company_id=?").bind(device.id, company.id),
      env.DB.prepare("DELETE FROM idempotency_keys WHERE device_id=?").bind(device.id),
      env.DB.prepare("DELETE FROM company_devices WHERE device_id=? AND company_id=?").bind(device.id, company.id),
      env.DB.prepare("DELETE FROM devices WHERE id=?").bind(device.id));
    for (const employee of employeeIds) statements.push(
      env.DB.prepare("DELETE FROM consent_events WHERE employee_id=? AND company_id=?")
        .bind(employee.id, company.id),
      env.DB.prepare("DELETE FROM company_employees WHERE employee_id=? AND company_id=?")
        .bind(employee.id, company.id),
      env.DB.prepare("DELETE FROM employees WHERE id=?").bind(employee.id));
  }
  if (item.target_type === "company") {
    statements.push(
      env.DB.prepare("DELETE FROM opportunity_states WHERE company_id=?").bind(company.id),
      env.DB.prepare("DELETE FROM classification_rules WHERE company_id=?").bind(company.id),
      env.DB.prepare("DELETE FROM consent_events WHERE company_id=?").bind(company.id),
      env.DB.prepare("DELETE FROM device_heartbeats WHERE company_id=?").bind(company.id),
      env.DB.prepare("DELETE FROM collection_policies WHERE company_id=?").bind(company.id),
      env.DB.prepare("DELETE FROM delivery_channels WHERE company_id=?").bind(company.id),
      env.DB.prepare("DELETE FROM delivery_schedules WHERE company_id=?").bind(company.id),
      env.DB.prepare("DELETE FROM report_deliveries WHERE company_id=?").bind(company.id));
  }
  const now = new Date().toISOString(), receiptId = crypto.randomUUID();
  statements.push(env.DB.prepare(`INSERT INTO deletion_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(receiptId, company.id, requestId, item.target_type, await sha256(item.target_id), reportIds.length,
      devices.length, employeeIds.length, company.email, now),
    env.DB.prepare("UPDATE privacy_requests SET status='completed', resolved_by=?, resolved_at=? WHERE id=? AND company_id=?")
      .bind(company.email, now, requestId, company.id));
  await env.DB.batch(statements);
  await audit(env, "admin", company.email, "privacy_deletion.executed", "company", company.id,
    { requestId, receiptId, targetType: item.target_type, reportsDeleted: reportIds.length,
      devicesDeleted: devices.length, employeesDeleted: employeeIds.length });
  return json({ ok: true, receiptId, reportsDeleted: reportIds.length, devicesDeleted: devices.length,
    employeesDeleted: employeeIds.length });
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

const canMutate = (company, pathname) => {
  if (company.role === "owner") return true;
  if (company.role === "auditor") return false;
  return /^\/api\/admin\/(reports\/[^/]+\/(workflow|deliver|pdf-audit)|opportunities\/state|classification-corrections)$/.test(pathname);
};

async function createAdminUser(request, env, company) {
  const body = await request.json();
  const email = String(body.email || "").trim().toLowerCase();
  const role = String(body.role || "manager");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !["owner", "manager", "auditor"].includes(role)) {
    return json({ error: "invalid_admin_user" }, 400);
  }
  const exists = await env.DB.prepare("SELECT email FROM admin_users WHERE company_id=? AND email=?")
    .bind(company.id, email).first();
  if (exists) return json({ error: "admin_user_exists" }, 409);
  const temporaryPassword = randomToken(18);
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO admin_users VALUES (?, ?, ?, ?, 'active', NULL, NULL, 0, ?, ?, ?)`)
    .bind(company.id, email, await hashPassword(temporaryPassword), role, company.email, now, now).run();
  await audit(env, "admin", company.email, "admin_user.created", "company", company.id, { email, role });
  return json({ email, role, temporaryPassword }, 201);
}

async function updateAdminUser(request, env, company, emailValue) {
  const email = decodeURIComponent(emailValue).trim().toLowerCase();
  const body = await request.json();
  const role = String(body.role || "");
  const status = String(body.status || "");
  if (!["owner", "manager", "auditor"].includes(role) || !["active", "suspended"].includes(status)
    || (email === company.email && status !== "active")) return json({ error: "invalid_admin_user" }, 400);
  const existing = await env.DB.prepare("SELECT role,status FROM admin_users WHERE company_id=? AND email=?")
    .bind(company.id, email).first();
  if (!existing) return json({ error: "not_found" }, 404);
  if (existing.role === "owner" && (role !== "owner" || status !== "active")) {
    const owners = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM admin_users WHERE company_id=? AND role='owner' AND status='active'",
    ).bind(company.id).first();
    if (Number(owners.count) <= 1) return json({ error: "last_owner_required" }, 409);
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE admin_users SET role=?,status=?,updated_at=? WHERE company_id=? AND email=?")
      .bind(role, status, now, company.id, email),
    ...(status === "suspended" ? [env.DB.prepare("DELETE FROM admin_sessions WHERE company_id=? AND email=?")
      .bind(company.id, email)] : []),
  ]);
  await audit(env, "admin", company.email, "admin_user.updated", "company", company.id,
    { email, fromRole: existing.role, toRole: role, fromStatus: existing.status, toStatus: status });
  return json({ ok: true, email, role, status });
}

async function revokeAdminSessions(env, company, emailValue) {
  const email = decodeURIComponent(emailValue).trim().toLowerCase();
  if (!await env.DB.prepare("SELECT email FROM admin_users WHERE company_id=? AND email=?")
    .bind(company.id, email).first()) return json({ error: "not_found" }, 404);
  await env.DB.prepare("DELETE FROM admin_sessions WHERE company_id=? AND email=?")
    .bind(company.id, email).run();
  await audit(env, "admin", company.email, "admin_user.sessions_revoked", "company", company.id, { email });
  return json({ ok: true });
}

async function enrollMfa(env, company) {
  const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
  const encrypted = await encryptSecret(env, secret);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await env.DB.prepare(`INSERT INTO admin_mfa_enrollments VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(company_id,email) DO UPDATE SET secret_cipher=excluded.secret_cipher,
    secret_nonce=excluded.secret_nonce,expires_at=excluded.expires_at`)
    .bind(company.id, company.email, encrypted.cipher, encrypted.nonce, expiresAt).run();
  const issuer = encodeURIComponent("Work Visibility AI");
  const account = encodeURIComponent(`${company.name}:${company.email}`);
  return json({ secret, otpauthUri: `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}`,
    expiresAt });
}

async function confirmMfa(request, env, company) {
  const enrollment = await env.DB.prepare(`SELECT * FROM admin_mfa_enrollments
    WHERE company_id=? AND email=? AND expires_at>?`).bind(company.id, company.email,
    new Date().toISOString()).first();
  if (!enrollment) return json({ error: "mfa_enrollment_expired" }, 409);
  const secret = await decryptSecret(env, enrollment.secret_cipher, enrollment.secret_nonce);
  const body = await request.json();
  if (!await validTotp(secret, String(body.otp || ""))) return json({ error: "invalid_otp" }, 400);
  const encrypted = await encryptSecret(env, secret), now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE admin_users SET mfa_secret_cipher=?,mfa_secret_nonce=?,mfa_enabled=1,
      updated_at=? WHERE company_id=? AND email=?`).bind(encrypted.cipher, encrypted.nonce, now,
      company.id, company.email),
    env.DB.prepare("DELETE FROM admin_mfa_enrollments WHERE company_id=? AND email=?")
      .bind(company.id, company.email),
  ]);
  await audit(env, "admin", company.email, "mfa.enabled", "company", company.id);
  return json({ ok: true, mfaEnabled: true });
}

async function changePassword(request, env, company) {
  const body = await request.json();
  const currentPassword = String(body.currentPassword || ""), newPassword = String(body.newPassword || "");
  const user = await env.DB.prepare("SELECT password_hash FROM admin_users WHERE company_id=? AND email=?")
    .bind(company.id, company.email).first();
  if (!user || !await verifyPassword(currentPassword, user.password_hash)) {
    return json({ error: "current_password_invalid" }, 401);
  }
  if (newPassword.length < 12 || newPassword.length > 256 || newPassword === currentPassword
    || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    return json({ error: "weak_password" }, 400);
  }
  const currentHash = await sha256(company.sessionToken), now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE admin_users SET password_hash=?,updated_at=? WHERE company_id=? AND email=?")
      .bind(await hashPassword(newPassword), now, company.id, company.email),
    env.DB.prepare("DELETE FROM admin_sessions WHERE company_id=? AND email=? AND token_hash<>?")
      .bind(company.id, company.email, currentHash),
  ]);
  await audit(env, "admin", company.email, "password.changed", "company", company.id);
  return json({ ok: true });
}

const deliveryHint = (channel, destination) => channel === "email"
  ? destination.replace(/^(.{2}).*(@.*)$/, "$1***$2") : new URL(destination).hostname;

async function configureDeliveryChannel(request, env, company) {
  const body = await request.json(), channel = String(body.channel || "");
  const destination = String(body.destination || "").trim();
  const enabled = body.enabled !== false;
  const emailValid = channel === "email" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destination);
  let webhookValid = false;
  if (["slack", "teams"].includes(channel)) {
    try {
      const url = new URL(destination);
      webhookValid = url.protocol === "https:" && (channel === "slack"
        ? url.hostname === "hooks.slack.com" : /(^|\.)(office\.com|office365\.com)$/.test(url.hostname));
    } catch { webhookValid = false; }
  }
  if (!emailValid && !webhookValid) return json({ error: "invalid_delivery_destination" }, 400);
  const encrypted = await encryptSecret(env, destination), now = new Date().toISOString();
  const existing = await env.DB.prepare("SELECT id,created_at,created_by FROM delivery_channels WHERE company_id=? AND channel=?")
    .bind(company.id, channel).first();
  await env.DB.prepare(`INSERT INTO delivery_channels VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id,channel) DO UPDATE SET destination_cipher=excluded.destination_cipher,
    destination_nonce=excluded.destination_nonce,destination_hint=excluded.destination_hint,
    enabled=excluded.enabled,updated_at=excluded.updated_at`).bind(existing?.id || crypto.randomUUID(), company.id,
    channel, encrypted.cipher, encrypted.nonce, deliveryHint(channel, destination), Number(enabled),
    existing?.created_by || company.email, existing?.created_at || now, now).run();
  await audit(env, "admin", company.email, "delivery_channel.updated", "company", company.id,
    { channel, enabled, destinationHint: deliveryHint(channel, destination) });
  return json({ ok: true, channel, enabled, destinationHint: deliveryHint(channel, destination) });
}

async function configureDeliverySchedule(request, env, company) {
  const body = await request.json(), channel = String(body.channel || "");
  const weekday = Number(body.weekday), hour = Number(body.hour);
  const timezone = String(body.timezone || "Asia/Tokyo"), review = body.humanReviewRequired !== false;
  if (!["email", "slack", "teams"].includes(channel) || !Number.isInteger(weekday) || weekday < 0
    || weekday > 6 || !Number.isInteger(hour) || hour < 0 || hour > 23
    || !/^[A-Za-z_]+\/[A-Za-z_+-]+$/.test(timezone)) return json({ error: "invalid_schedule" }, 400);
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO delivery_schedules VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(company_id,channel) DO UPDATE SET weekday=excluded.weekday,hour=excluded.hour,
    timezone=excluded.timezone,human_review_required=excluded.human_review_required,
    enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
    .bind(crypto.randomUUID(), company.id, channel, weekday, hour, timezone, Number(review),
      company.email, now).run();
  await audit(env, "admin", company.email, "delivery_schedule.updated", "company", company.id,
    { channel, weekday, hour, timezone, humanReviewRequired: review });
  return json({ ok: true });
}

async function deliverReport(env, company, reportId, channel, baseUrl, actor = company.email) {
  const report = await env.DB.prepare(`SELECT r.content_cipher,r.content_nonce,r.period_start,r.period_end,
    e.display_name,COALESCE(w.status,'finalized') AS workflow_status FROM reports r
    JOIN company_reports cr ON cr.report_id=r.id JOIN employees e ON e.id=r.employee_id
    LEFT JOIN report_workflows w ON w.report_id=r.id AND w.company_id=cr.company_id
    WHERE r.id=? AND cr.company_id=?`).bind(reportId, company.id).first();
  if (!report) return json({ error: "not_found" }, 404);
  if (report.workflow_status !== "finalized") return json({ error: "report_not_finalized" }, 409);
  const config = await env.DB.prepare("SELECT * FROM delivery_channels WHERE company_id=? AND channel=? AND enabled=1")
    .bind(company.id, channel).first();
  if (!config) return json({ error: "delivery_channel_not_configured" }, 409);
  const id = crypto.randomUUID(), now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO report_deliveries VALUES (?, ?, ?, ?, ?, 'sending', NULL, NULL, ?, ?, NULL)`)
    .bind(id, company.id, reportId, channel, config.destination_hint, actor, now).run();
  try {
    const destination = await decryptSecret(env, config.destination_cipher, config.destination_nonce);
    const title = `${report.display_name} ${report.period_start}〜${report.period_end} 週次管理レポート`;
    const reportUrl = `${String(baseUrl || "").replace(/\/$/, "")}/`;
    let reference = null;
    if (channel === "email") {
      if (!env.EMAIL || !env.REPORT_EMAIL_FROM) throw Object.assign(new Error("email_service_not_configured"),
        { code: "email_service_not_configured" });
      const html = await decryptReport(env, report.content_cipher, report.content_nonce);
      const sent = await env.EMAIL.send({ to: destination,
        from: { email: env.REPORT_EMAIL_FROM, name: "Work Visibility AI" }, subject: title,
        html, text: `${title}\n${reportUrl}` });
      reference = sent?.messageId || null;
    } else {
      const payload = channel === "slack" ? { text: `${title}\n${reportUrl}` }
        : { text: title, type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive",
          content: { type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", text: title }],
            actions: [{ type: "Action.OpenUrl", title: "管理画面で開く", url: reportUrl }] } }] };
      const response = await fetch(destination, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(payload) });
      if (!response.ok) throw Object.assign(new Error("webhook_delivery_failed"), { code: `http_${response.status}` });
    }
    const completedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE report_deliveries SET status='delivered',provider_reference=?,completed_at=? WHERE id=?")
        .bind(reference, completedAt, id),
      env.DB.prepare("UPDATE report_workflows SET status='delivered',updated_by=?,updated_at=? WHERE report_id=? AND company_id=?")
        .bind(actor, completedAt, reportId, company.id),
    ]);
    await audit(env, "admin", actor, "report.delivered", "report", reportId, { deliveryId: id, channel });
    return json({ id, status: "delivered", channel });
  } catch (error) {
    await env.DB.prepare("UPDATE report_deliveries SET status='failed',error_code=?,completed_at=? WHERE id=?")
      .bind(String(error?.code || "delivery_failed").slice(0, 128), new Date().toISOString(), id).run();
    await audit(env, "admin", actor, "report.delivery_failed", "report", reportId,
      { deliveryId: id, channel, errorCode: String(error?.code || "delivery_failed").slice(0, 128) });
    return json({ error: error?.code || "delivery_failed", deliveryId: id }, 503);
  }
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
       WHERE cr.company_id=? AND r.received_at<? AND NOT EXISTS (
         SELECT 1 FROM legal_holds h WHERE h.company_id=cr.company_id AND h.status='active' AND
         ((h.target_type='company' AND h.target_id=cr.company_id) OR
          (h.target_type='report' AND h.target_id=r.id) OR
          (h.target_type='employee' AND h.target_id=r.employee_id))) LIMIT 500`,
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
      statements.push(env.DB.prepare("DELETE FROM classification_corrections WHERE report_id=?").bind(row.id));
      statements.push(env.DB.prepare("DELETE FROM report_metrics WHERE report_id=?").bind(row.id));
      statements.push(env.DB.prepare("DELETE FROM reports WHERE id=?").bind(row.id));
      statements.push(env.DB.prepare(
        "INSERT INTO audit_events VALUES (?, 'system', NULL, 'report.expired', 'company', ?, ?, ?)",
      ).bind(crypto.randomUUID(), company.id, new Date().toISOString(), JSON.stringify({ reportId: row.id })));
    }
  }
  statements.push(env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at<=?").bind(new Date().toISOString()));
  statements.push(env.DB.prepare("DELETE FROM oidc_transactions WHERE expires_at<=?").bind(new Date().toISOString()));
  await env.DB.batch(statements);
}

async function runScheduledDeliveries(env) {
  const schedules = await env.DB.prepare(`SELECT s.*,c.name FROM delivery_schedules s
    JOIN companies c ON c.id=s.company_id WHERE s.enabled=1 AND s.human_review_required=0
    AND c.status='active'`).all();
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  for (const schedule of schedules.results) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone,
      weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date())
      .filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    if (weekdays[parts.weekday] !== Number(schedule.weekday) || Number(parts.hour) !== Number(schedule.hour)) continue;
    const report = await env.DB.prepare(`SELECT r.id FROM reports r JOIN company_reports cr ON cr.report_id=r.id
      JOIN report_workflows w ON w.report_id=r.id AND w.company_id=cr.company_id
      WHERE cr.company_id=? AND w.status='finalized' AND NOT EXISTS (SELECT 1 FROM report_deliveries d
      WHERE d.company_id=cr.company_id AND d.report_id=r.id AND d.channel=? AND d.status IN ('sending','delivered'))
      ORDER BY r.period_start DESC,r.received_at DESC LIMIT 1`).bind(schedule.company_id, schedule.channel).first();
    if (report) await deliverReport(env, { id: schedule.company_id, name: schedule.name,
      email: "system", role: "owner" }, report.id, schedule.channel, env.PUBLIC_ADMIN_URL, "system");
  }
}

async function exportTenantData(env, company) {
  const [employees, devices, reports, settings, consent, auditRows, admins] = await Promise.all([
    env.DB.prepare(`SELECT e.id,e.display_name,e.department,e.status,e.created_at,ce.external_employee_id
      FROM company_employees ce JOIN employees e ON e.id=ce.employee_id WHERE ce.company_id=?`)
      .bind(company.id).all(),
    env.DB.prepare(`SELECT d.id,d.employee_id,d.name,d.status,d.app_version,d.last_seen_at,d.created_at
      FROM company_devices cd JOIN devices d ON d.id=cd.device_id WHERE cd.company_id=?`)
      .bind(company.id).all(),
    env.DB.prepare(`SELECT r.* FROM company_reports cr JOIN reports r ON r.id=cr.report_id
      WHERE cr.company_id=? ORDER BY r.period_start`).bind(company.id).all(),
    env.DB.prepare("SELECT * FROM company_settings WHERE company_id=?").bind(company.id).first(),
    env.DB.prepare("SELECT * FROM consent_events WHERE company_id=? ORDER BY occurred_at").bind(company.id).all(),
    env.DB.prepare(`SELECT actor_type,actor_id,action,target_type,target_id,occurred_at,metadata_json
      FROM audit_events WHERE target_type='company' AND target_id=? ORDER BY occurred_at`).bind(company.id).all(),
    env.DB.prepare("SELECT email,role,status,mfa_enabled,created_at,updated_at FROM admin_users WHERE company_id=?")
      .bind(company.id).all(),
  ]);
  const reportData = [];
  for (const { content_cipher, content_nonce, ...report } of reports.results) {
    reportData.push({ ...report, html: await decryptReport(env, content_cipher, content_nonce) });
  }
  await audit(env, "admin", company.email, "tenant.exported", "company", company.id,
    { employees: employees.results.length, devices: devices.results.length, reports: reportData.length });
  const payload = JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(),
    company: { id: company.id, name: company.name }, settings, administrators: admins.results.map(
      (item) => ({ ...item, mfa_enabled: Boolean(item.mfa_enabled) })), employees: employees.results,
    devices: devices.results, reports: reportData, consentEvents: consent.results,
    auditEvents: auditRows.results.map((item) => ({ ...item,
      metadata: JSON.parse(item.metadata_json || "{}"), metadata_json: undefined })) }, null, 2);
  return new Response(payload, { headers: { "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="tenant-export-${new Date().toISOString().slice(0, 10)}.json"`,
    "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

async function adminApi(request, env, pathname) {
  const company = await requireAdmin(request, env);
  if (!company) return json({ error: "admin_auth_required" }, 401);
  const selfSecurityPath = pathname.startsWith("/api/admin/mfa/") || pathname === "/api/admin/password";
  if (request.method !== "GET" && !selfSecurityPath && !canMutate(company, pathname)) {
    return json({ error: "permission_denied" }, 403);
  }
  if (company.role === "auditor" && /\/reports\/[^/]+\/(versions\/\d+\/)?content$/.test(pathname)) {
    return json({ error: "permission_denied" }, 403);
  }
  if (request.method === "POST" && pathname === "/api/admin/users") {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return createAdminUser(request, env, company);
  }
  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (request.method === "PATCH" && adminUserMatch) {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return updateAdminUser(request, env, company, adminUserMatch[1]);
  }
  const revokeSessionsMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/revoke-sessions$/);
  if (request.method === "POST" && revokeSessionsMatch) {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return revokeAdminSessions(env, company, revokeSessionsMatch[1]);
  }
  if (request.method === "POST" && pathname === "/api/admin/mfa/enroll") {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return enrollMfa(env, company);
  }
  if (request.method === "POST" && pathname === "/api/admin/mfa/confirm") {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return confirmMfa(request, env, company);
  }
  if (request.method === "GET" && pathname === "/api/admin/tenant-export") {
    if (company.role !== "owner") return json({ error: "permission_denied" }, 403);
    return exportTenantData(env, company);
  }
  if (request.method === "PUT" && pathname === "/api/admin/oidc-config") {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return configureOidc(request, env, company);
  }
  if (request.method === "PATCH" && pathname === "/api/admin/password") {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return changePassword(request, env, company);
  }
  if (request.method === "PUT" && pathname === "/api/admin/delivery-channel") {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return configureDeliveryChannel(request, env, company);
  }
  if (request.method === "PUT" && pathname === "/api/admin/delivery-schedule") {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return configureDeliverySchedule(request, env, company);
  }
  const deliverMatch = pathname.match(/^\/api\/admin\/reports\/([^/]+)\/deliver$/);
  if (request.method === "POST" && deliverMatch) {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    const body = await request.json();
    return deliverReport(env, company, deliverMatch[1], String(body.channel || ""),
      new URL(request.url).origin);
  }
  const pdfAuditMatch = pathname.match(/^\/api\/admin\/reports\/([^/]+)\/pdf-audit$/);
  if (request.method === "POST" && pdfAuditMatch) {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    if (!await env.DB.prepare("SELECT report_id FROM company_reports WHERE company_id=? AND report_id=?")
      .bind(company.id, pdfAuditMatch[1]).first()) return json({ error: "not_found" }, 404);
    await audit(env, "admin", company.email, "report.pdf_exported", "report", pdfAuditMatch[1]);
    return json({ ok: true });
  }
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
  if (request.method === "POST" && pathname === "/api/admin/classification-corrections") {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return createClassificationCorrection(request, env, company);
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
  if (request.method === "POST" && pathname === "/api/admin/legal-holds") {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return createLegalHold(request, env, company);
  }
  const holdMatch = pathname.match(/^\/api\/admin\/legal-holds\/([^/]+)\/release$/);
  if (request.method === "POST" && holdMatch) {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return releaseLegalHold(env, company, holdMatch[1]);
  }
  const executeDeletionMatch = pathname.match(/^\/api\/admin\/privacy-requests\/([^/]+)\/execute-deletion$/);
  if (request.method === "POST" && executeDeletionMatch) {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return executeDeletionRequest(env, company, executeDeletionMatch[1]);
  }
  if (request.method === "PUT" && pathname === "/api/admin/collection-policy") {
    if (!validCsrf(request, company)) return json({ error: "csrf_invalid" }, 403);
    return updateCollectionPolicy(request, env, company);
  }
  const contentMatch = pathname.match(/^\/api\/admin\/reports\/([^/]+)\/content$/);
  if (request.method === "GET" && contentMatch) return reportContent(env, company, contentMatch[1]);
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        await ensureSchema(env);
        return login(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/auth/oidc/start") {
        await ensureSchema(env);
        return startOidc(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/auth/oidc/callback") {
        await ensureSchema(env);
        return oidcCallback(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        await ensureSchema(env);
        return logout(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/auth/session") {
        await ensureSchema(env);
        const company = await requireAdmin(request, env);
        return company ? json({ company: { id: company.id, name: company.name }, email: company.email,
          role: company.role, csrfToken: company.csrfToken }) : json({ error: "admin_auth_required" }, 401);
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
      if (request.method === "POST" && url.pathname === "/api/v1/device/heartbeat") {
        await ensureSchema(env);
        return receiveHeartbeat(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/v1/device/policy") {
        await ensureSchema(env);
        return devicePolicy(request, env);
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
    await runScheduledDeliveries(env);
  },
};

export { decryptReport, encryptReport, normalizeReport, runRetention, runScheduledDeliveries,
  sha256, timingSafeMatch, verifyOidcIdToken };

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  department TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  app_version TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind = 'weekly'),
  audience TEXT NOT NULL CHECK(audience = 'management'),
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  content_cipher BLOB NOT NULL,
  content_nonce BLOB NOT NULL,
  content_sha256 TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE(employee_id, period_start, kind, audience)
);

CREATE TABLE IF NOT EXISTS report_metrics (
  report_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
  active_minutes INTEGER,
  idle_minutes INTEGER,
  categories_json TEXT NOT NULL DEFAULT '[]',
  capture_count INTEGER,
  work_log_count INTEGER
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  device_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(device_id, key)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  occurred_at TEXT NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_reports_period ON reports(period_start DESC);
CREATE INDEX IF NOT EXISTS idx_reports_employee ON reports(employee_id, period_start DESC);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_employees (
  company_id TEXT NOT NULL REFERENCES companies(id),
  employee_id TEXT NOT NULL UNIQUE REFERENCES employees(id),
  external_employee_id TEXT NOT NULL,
  PRIMARY KEY(company_id, external_employee_id)
);

CREATE TABLE IF NOT EXISTS company_devices (
  company_id TEXT NOT NULL REFERENCES companies(id),
  device_id TEXT NOT NULL UNIQUE REFERENCES devices(id)
);

CREATE TABLE IF NOT EXISTS company_reports (
  company_id TEXT NOT NULL REFERENCES companies(id),
  report_id TEXT NOT NULL UNIQUE REFERENCES reports(id)
);

CREATE INDEX IF NOT EXISTS idx_company_devices_company ON company_devices(company_id);
CREATE INDEX IF NOT EXISTS idx_company_reports_company ON company_reports(company_id);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  email TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  attempt_key TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL,
  window_started_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_settings (
  company_id TEXT PRIMARY KEY REFERENCES companies(id),
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  week_start INTEGER NOT NULL DEFAULT 1,
  report_retention_days INTEGER NOT NULL DEFAULT 90,
  audit_retention_days INTEGER NOT NULL DEFAULT 365,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_occurred ON audit_events(occurred_at DESC);

export const schema = `
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

CREATE TABLE IF NOT EXISTS report_versions (id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id), revision INTEGER NOT NULL, content_cipher BLOB NOT NULL, content_nonce BLOB NOT NULL, content_sha256 TEXT NOT NULL, generated_at TEXT NOT NULL, received_at TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(report_id, revision));
CREATE TABLE IF NOT EXISTS report_workflows (report_id TEXT PRIMARY KEY REFERENCES reports(id), company_id TEXT NOT NULL REFERENCES companies(id), status TEXT NOT NULL DEFAULT 'finalized', review_note TEXT, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS opportunity_states (company_id TEXT NOT NULL REFERENCES companies(id), opportunity_key TEXT NOT NULL, department TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', owner TEXT, next_action TEXT, decision_reason TEXT, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(company_id, opportunity_key));
CREATE TABLE IF NOT EXISTS classification_rules (company_id TEXT NOT NULL REFERENCES companies(id), category TEXT NOT NULL, display_name TEXT NOT NULL, automation_rate REAL NOT NULL, status TEXT NOT NULL DEFAULT 'active', updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(company_id, category));
CREATE TABLE IF NOT EXISTS privacy_requests (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), request_type TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'requested', reason TEXT, requested_by TEXT NOT NULL, requested_at TEXT NOT NULL, resolved_by TEXT, resolved_at TEXT);
CREATE TABLE IF NOT EXISTS consent_events (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), employee_id TEXT, status TEXT NOT NULL, source TEXT NOT NULL, occurred_at TEXT NOT NULL, recorded_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS device_heartbeats (device_id TEXT NOT NULL REFERENCES devices(id), company_id TEXT NOT NULL REFERENCES companies(id), metric_date TEXT NOT NULL, app_version TEXT, collection_state TEXT NOT NULL, scheduled_count INTEGER NOT NULL, eligible_count INTEGER NOT NULL, captured_count INTEGER NOT NULL, failed_count INTEGER NOT NULL, missing_count INTEGER NOT NULL, analyzed_count INTEGER NOT NULL, analysis_failed_count INTEGER NOT NULL, pause_reasons_json TEXT NOT NULL DEFAULT '{}', policy_version INTEGER, received_at TEXT NOT NULL, PRIMARY KEY(device_id, metric_date));
CREATE TABLE IF NOT EXISTS collection_policies (company_id TEXT PRIMARY KEY REFERENCES companies(id), version INTEGER NOT NULL, collection_enabled INTEGER NOT NULL DEFAULT 1, excluded_apps_json TEXT NOT NULL DEFAULT '[]', excluded_url_patterns_json TEXT NOT NULL DEFAULT '[]', excluded_time_ranges_json TEXT NOT NULL DEFAULT '[]', purpose_text TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

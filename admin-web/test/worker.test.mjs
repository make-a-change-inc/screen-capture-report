import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptReport,
  encryptReport,
  normalizeReport,
  sha256,
  timingSafeMatch,
} from "../worker/index.js";

const key = Buffer.alloc(32, 7).toString("base64");

test("report encryption round-trips without plaintext storage", async () => {
  const env = { REPORT_ENCRYPTION_KEY_V1: key };
  const encrypted = await encryptReport(env, "管理者向け合成レポート");

  assert.notEqual(Buffer.from(encrypted.cipher).toString("utf8"), "管理者向け合成レポート");
  assert.equal(
    await decryptReport(env, encrypted.cipher, encrypted.nonce),
    "管理者向け合成レポート",
  );
});

test("admin token comparison uses its sha256 digest", async () => {
  const expected = await sha256("correct-token");
  assert.equal(await timingSafeMatch("correct-token", expected), true);
  assert.equal(await timingSafeMatch("wrong-token", expected), false);
});

test("desktop snake_case payload normalizes to weekly report contract", () => {
  const report = normalizeReport({
    schema_version: 1,
    report_id: "report-1",
    period_start: "2026-07-06",
    period_end: "2026-07-12",
    report_html: "<h1>weekly</h1>",
  });

  assert.equal(report.reportId, "report-1");
  assert.equal(report.reportHtml, "<h1>weekly</h1>");
  assert.equal(report.periodStart, "2026-07-06");
});

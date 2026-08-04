import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptReport,
  encryptReport,
  normalizeReport,
  sha256,
  timingSafeMatch,
  verifyOidcIdToken,
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

test("OIDC ID tokens require a valid RS256 signature and bound claims", async (t) => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  Object.assign(jwk, { kid: "test-key", use: "sig", alg: "RS256" });
  const encode = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value))
    .toString("base64url");
  const nonce = "nonce-value", issuer = "https://idp.example.test", clientId = "client-id";
  const header = encode({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const payload = encode({ iss: issuer, aud: clientId, sub: "subject-1", email: "user@example.test",
    email_verified: true, nonce, iat: Math.floor(Date.now() / 1000) - 5,
    exp: Math.floor(Date.now() / 1000) + 300 });
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`));
  const token = `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), {
    headers: { "content-type": "application/json" },
  });
  t.after(() => { globalThis.fetch = originalFetch; });
  const nonceHash = await sha256(nonce);
  const claims = await verifyOidcIdToken(token, { issuer, jwks_uri: `${issuer}/jwks` }, clientId,
    nonceHash);
  assert.equal(claims.email, "user@example.test");
  await assert.rejects(() => verifyOidcIdToken(token, { issuer, jwks_uri: `${issuer}/jwks` },
    "wrong-client", nonceHash), /invalid_id_token_claims/);
});

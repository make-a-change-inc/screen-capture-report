import assert from "node:assert/strict";
import test from "node:test";

import { adminPage } from "../worker/admin-page.js";

test("successful login hides the login overlay", () => {
  assert.match(adminPage, /\.login\[hidden\]\{display:none\}/);
  assert.match(adminPage, /\$\('#login'\)\.hidden=true/);
});

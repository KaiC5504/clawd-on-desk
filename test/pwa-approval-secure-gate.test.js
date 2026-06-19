"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "pwa", "app.js"), "utf8");

describe("pwa approval secure-context gate", () => {
  it("falls back to a read-only render when not paired+secure", () => {
    assert.match(app, /if \(!\(this\.paired && this\.secure\)\) inner \+= this\._renderReadOnly/);
  });

  it("shows the pair / HTTPS hint in the read-only fallback", () => {
    assert.match(app, /_renderReadOnly\(a, kind\)/);
    assert.match(app, /this\.paired \? "approval_secure_hint" : "approval_pair_hint"/);
  });

  it("binds interactive controls only when paired+secure and not resolving", () => {
    assert.match(app, /var interactive = this\.paired && this\.secure && !outcome && !resolving/);
    assert.match(app, /if \(interactive\) \{/);
  });
});

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "app.js"), "utf8");

describe("pwa code entry — smooth iOS typing via a single capture input", () => {
  it("captures the whole code in one input, not eight focus-advancing boxes", () => {
    assert.match(src, /class="code-input"/, "should render one capture input");
    assert.match(src, /maxlength="8"/, "the capture input holds the full 8-char code");
    assert.doesNotMatch(src, /maxlength="1"/, "no per-character maxlength=1 inputs");
  });

  it("does not hop focus between boxes on every keystroke (the iOS lag source)", () => {
    assert.doesNotMatch(src, /boxes\[\s*idx\s*\+\s*1\s*\]\.focus\(\)/, "per-keystroke focus advance must be gone");
  });

  it("still renders the 8 visual cells", () => {
    assert.match(src, /class="code-box"/, "visual cells preserved");
  });
});

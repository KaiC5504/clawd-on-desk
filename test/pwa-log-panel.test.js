"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "..", "pwa", "style.css"), "utf8");
const body = (css.match(/\.log-body\s*\{([^}]*)\}/) || [, ""])[1];

describe("pwa log panel — expanded box is detached and fully rounded", () => {
  it("rounds all four corners (not just the bottom)", () => {
    assert.ok(body, ".log-body rule should exist");
    assert.doesNotMatch(body, /border-radius:\s*0\s+0/, "top corners must be rounded, not square");
    assert.match(body, /border-radius:\s*var\(--radius\)/, "should use the full --radius on every corner");
  });

  it("sits below the toggle with a small gap and a full border", () => {
    assert.match(body, /margin-top:/, "needs a small top margin so it doesn't stick to the toggle");
    assert.doesNotMatch(body, /border-top:\s*none/, "needs a complete border, not a missing top edge");
  });
});

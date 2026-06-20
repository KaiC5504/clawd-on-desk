"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "app.js"), "utf8");

describe("pwa connection — connected toast only on the first pairing", () => {
  it("suppresses the toast for an already-paired device (reconnect or cold relaunch)", () => {
    // An already-paired device is "still connected" — a foreground reconnect or a
    // cold relaunch must not re-announce. Only a genuine first pairing (no stored
    // credential yet → !isPaired()) shows the toast.
    assert.match(
      src,
      /if\s*\([\s\S]*?!\s*self\.isPaired\(\)[\s\S]*?\)\s*\{[\s\S]{0,200}?showToast\(\s*t\(\s*["']toast_connected["']\s*\)/,
      "showToast(toast_connected) must be gated behind `!self.isPaired()`"
    );
  });

  it("also dedups within a single session via a first-connect flag", () => {
    assert.match(src, /_hasConnectedOnce/, "keep a per-session guard against a double-toast during first pairing");
  });
});

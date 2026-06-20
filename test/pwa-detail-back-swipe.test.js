"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "pwa");
const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "style.css"), "utf8");
const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");

describe("pwa session detail — icon-only back button", () => {
  it("renders an icon-only back button (no visible 'Back' label) with an aria-label", () => {
    const buttons = app.match(/<button class="detail-back icon-only"[^>]*>/g) || [];
    assert.equal(buttons.length, 2, "shell + populated detail header each render the icon-only button");
    for (const b of buttons) assert.match(b, /aria-label="/, "icon-only button keeps a label for screen readers");
  });

  it("drops the text span from the detail header back button", () => {
    // The icon-only button is icon + nothing else; the only remaining span-wrapped
    // detail_back is the approval modal's separate 'Back to menu' button.
    assert.doesNotMatch(app, /icon\("arrowLeft"\) \+ '<span>' \+ esc\(t\("detail_back"\)\)/);
  });

  it("enlarges the glyph for the icon-only variant", () => {
    const m = css.match(/\.detail-back\.icon-only svg\s*\{[^}]*width:\s*(\d+)px/);
    assert.ok(m, ".detail-back.icon-only svg rule should exist");
    assert.ok(Number(m[1]) > 18, "icon-only glyph should be larger than the default 18px");
  });
});

describe("pwa session detail — iOS edge-swipe back", () => {
  it("binds the swipe gesture from the DetailRenderer constructor", () => {
    assert.match(app, /_bindSwipe\(\)\s*\{/);
    assert.match(app, /this\._bindSwipe\(\);/);
  });

  it("tracks the full touch lifecycle so vertical scroll still works", () => {
    for (const ev of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      assert.match(app, new RegExp('addEventListener\\("' + ev + '"'), `should listen for ${ev}`);
    }
    // touchmove must be non-passive so it can preventDefault during a back-drag.
    assert.match(app, /"touchmove"[\s\S]*?\{ passive: false \}/);
  });

  it("only starts from the left edge and commits past a fraction of the width", () => {
    assert.match(app, /var EDGE = \d+;/);
    assert.match(app, /var TRIGGER = 0\.\d+;/);
  });
});

describe("pwa service worker — cache bumped so the change ships", () => {
  it("uses at least clawd-mobile-v19", () => {
    const m = sw.match(/clawd-mobile-v(\d+)/);
    assert.ok(m, "CACHE_NAME should follow the clawd-mobile-vN convention");
    assert.ok(Number(m[1]) >= 19, `cache version ${m[1]} must be bumped to ship the new UI`);
  });
});

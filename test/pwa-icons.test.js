"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const icons = require("../pwa/icons.js");

describe("pwa icons — event icons are SVG, not emoji", () => {
  it("every event type maps to an existing non-empty SVG", () => {
    const { ICONS, EVENT_ICONS } = icons;
    const types = Object.keys(EVENT_ICONS);
    assert.ok(types.length >= 14, "should cover the full event set");
    for (const type of types) {
      const name = EVENT_ICONS[type];
      assert.match(name, /^[a-zA-Z]+$/, `${type} -> "${name}" must be an icon name, not a glyph`);
      const svg = ICONS[name];
      assert.strictEqual(typeof svg, "string", `icon "${name}" (for ${type}) must exist`);
      assert.ok(svg.includes("<svg"), `icon "${name}" must be an SVG`);
    }
  });

  it("a 'dot' fallback icon exists for unknown events", () => {
    assert.ok(icons.ICONS.dot && icons.ICONS.dot.includes("<svg"), "ICONS.dot SVG must exist");
  });

  it("EVENT_ICONS values are all ASCII (no emoji)", () => {
    for (const v of Object.values(icons.EVENT_ICONS)) {
      assert.doesNotMatch(v, /[^\x00-\x7F]/, `event icon "${v}" must be ASCII`);
    }
  });
});

describe("pwa icons — Lucide style conformance", () => {
  it("every icon uses a 24x24 viewBox and inherits color via currentColor", () => {
    for (const [name, svg] of Object.entries(icons.ICONS)) {
      assert.ok(svg.includes('viewBox="0 0 24 24"'), `${name} must use a 24x24 viewBox`);
      assert.ok(
        svg.includes('stroke="currentColor"') || svg.includes('fill="currentColor"'),
        `${name} must inherit color via currentColor`
      );
    }
  });
});

describe("pwa icons — no emoji/unicode glyphs left in app.js", () => {
  it("app.js routes all icons through icon() (no emoji or legacy glyphs)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "app.js"), "utf8");
    const glyphs = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}⏹▶●✅❌✕❓️]/u;
    assert.doesNotMatch(src, glyphs,
      "app.js should not contain emoji or the legacy bullet/close glyphs — route them through icon()");
  });
});

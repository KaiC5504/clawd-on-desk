"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "pwa", "app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "pwa", "style.css"), "utf8");
const i18n = require("../pwa/i18n.js");

describe("pwa detail renderer — markdown output", () => {
  it("renders lastOutput through mdToHtml (not raw esc)", () => {
    assert.doesNotMatch(app, /'<div class="detail-output">' \+ esc\(data\.lastOutput\)/);
    assert.match(app, /mdToHtml\(data\.lastOutput\)/);
  });

  it("wraps detail-output in approval-md so markdown styles apply", () => {
    assert.match(app, /class="detail-output approval-md"/);
  });
});

describe("pwa detail renderer — live now-tool status", () => {
  it("renders detail-now only when data.currentTool is present", () => {
    assert.match(app, /if \(data\.currentTool\)/);
    assert.match(app, /class="detail-now"/);
  });

  it("uses t(\"detail_now\") for the label (not a hardcoded string)", () => {
    assert.match(app, /t\("detail_now"\)/);
  });

  it("esc()s currentTool and toolSummary", () => {
    assert.match(app, /esc\(data\.currentTool\)/);
    assert.match(app, /esc\(data\.toolSummary\)/);
  });

  it("appends toolSummary only when present", () => {
    assert.match(app, /data\.toolSummary \? ' ' \+ esc\(data\.toolSummary\) : ''/);
  });
});

describe("pwa detail renderer — detail-now CSS", () => {
  it("defines a .detail-now rule", () => {
    assert.match(css, /\.detail-now\s*\{/);
  });

  it("uses only design tokens (no hardcoded colors)", () => {
    const rule = css.match(/\.detail-now\s*\{[^}]+\}/)?.[0] || "";
    assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,6}/);
    assert.doesNotMatch(rule, /rgb\(/);
  });
});

describe("pwa detail renderer — i18n detail_now key", () => {
  it("defines detail_now for all 5 languages", () => {
    const entry = i18n.I18N["detail_now"];
    assert.ok(entry, "detail_now must exist in the dictionary");
    for (const lang of i18n.SUPPORTED_LANGS) {
      assert.strictEqual(typeof entry[lang], "string", `detail_now.${lang} must be a string`);
      assert.ok(entry[lang].length > 0, `detail_now.${lang} must be non-empty`);
    }
  });
});

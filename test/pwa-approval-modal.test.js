"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "pwa");
const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "style.css"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

describe("pwa approval modal — element + layering", () => {
  it("mounts a dedicated #approval-modal overlay element", () => {
    assert.match(html, /<div id="approval-modal" class="hidden">/);
  });

  it("layers the modal above the detail overlay (1500) and below toasts (2000)", () => {
    const m = css.match(/#approval-modal\s*\{[^}]*z-index:\s*(\d+)/);
    assert.ok(m, "#approval-modal must set a z-index");
    const z = Number(m[1]);
    assert.ok(z > 1500 && z < 2000, `z-index ${z} should sit between detail (1500) and toast (2000)`);
  });

  it("uses a blurred backdrop layer (the one new visual)", () => {
    assert.match(css, /\.approval-backdrop\s*\{[^}]*backdrop-filter:\s*blur/);
  });

  it("passes the modal element into the ApprovalRenderer constructor", () => {
    assert.match(app, /new ApprovalRenderer\(document\.getElementById\("approval-list"\), document\.getElementById\("approval-modal"\)\)/);
  });
});

describe("pwa approval modal — collapse-to-pill state machine", () => {
  it("tracks expanded / userCollapsed / activeHandle / drafts state", () => {
    assert.match(app, /this\.expanded = false/);
    assert.match(app, /this\.userCollapsed = false/);
    assert.match(app, /this\.activeHandle = null/);
    assert.match(app, /this\.drafts = new Map\(\)/);
  });

  it("has expand(), collapse(userInitiated) and a focusHandle deep-link entry", () => {
    assert.match(app, /\bexpand\(\)\s*\{/);
    assert.match(app, /collapse\(userInitiated\)\s*\{/);
    assert.match(app, /focusHandle\(handle\)\s*\{/);
  });

  it("renders a pill with a live pending count", () => {
    assert.match(app, /class="approval-pill"/);
    assert.match(app, /t\("approval_pill_pending", \{ n: this\.approvals\.size \}\)/);
  });

  it('wires "Back to menu" to a user-initiated collapse', () => {
    assert.match(app, /approval_back_to_menu/);
    assert.match(app, /self\.collapse\(true\)/);
  });

  it("auto-expands only when idle (not when the user collapsed)", () => {
    assert.match(app, /else if \(!this\.userCollapsed\)\s*\{\s*\n\s*this\.expand\(\)/);
  });

  it("preserves an in-progress draft by scraping before re-render/collapse", () => {
    assert.match(app, /_scrapeActiveDraft\(\)/);
    assert.match(app, /_restoreDraft\(/);
  });
});

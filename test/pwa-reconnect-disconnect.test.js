"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "app.js"), "utf8");
const sw = fs.readFileSync(path.join(__dirname, "..", "pwa", "sw.js"), "utf8");
const i18n = require("../pwa/i18n.js");

describe("pwa self-heal rediscovery — connection-info target", () => {
  it("has a helper that resolves the WS target from /api/connection-info", () => {
    assert.match(src, /\/api\/connection-info/, "must fetch /api/connection-info to rediscover the live port");
    assert.match(src, /_resolveTarget|_targetFromConnectionInfo|resolveLiveTarget/,
      "expected an async target-resolution helper");
  });

  it("picks httpsPort on an https page and port otherwise", () => {
    assert.match(src, /info\.httpsPort/, "must read info.httpsPort for a secure page");
    assert.match(src, /info\.port/, "must read info.port for a plain page");
  });

  it("keeps location.hostname (does NOT swap to lanIp) so the cert SAN still matches", () => {
    // The resolver must build host from location.hostname, never info.lanIp, to keep
    // clawd.local stable for the cert.
    assert.doesNotMatch(src, /host\s*[:=]\s*info\.lanIp/, "must not target info.lanIp as the host");
  });

  it("falls back to _locationTarget() and never hard-depends on the fetch", () => {
    assert.match(src, /_locationTarget\(\)/, "must fall back to _locationTarget on fetch failure");
  });
});

describe("pwa phone-side disconnect — ConnectionManager.forget()", () => {
  it("defines a forget() method", () => {
    assert.match(src, /forget\s*\(\s*\)\s*\{/, "ConnectionManager.forget() must exist");
  });

  it("clears the reconnect timer and parks on the code-entry screen", () => {
    const m = src.match(/forget\s*\(\s*\)\s*\{[\s\S]*?\n\s{4}\}/);
    assert.ok(m, "could not isolate forget() body");
    const body = m[0];
    assert.match(body, /clearTimeout\(\s*this\.reconnectTimer\s*\)/, "must clear the reconnect timer");
    assert.match(body, /this\.paired\s*=\s*null/, "must drop the durable pairing");
    assert.match(body, /this\._needCode\s*=\s*true/, "must park on code-entry (suspend auto-reconnect)");
  });

  it("removes pairing AND history but keeps the device id", () => {
    const m = src.match(/forget\s*\(\s*\)\s*\{[\s\S]*?\n\s{4}\}/);
    const body = m[0];
    assert.match(body, /removeItem\(\s*["']clawd-pairing["']\s*\)/, "must remove clawd-pairing");
    assert.match(body, /removeItem\(\s*["']clawd-history["']\s*\)/, "must remove clawd-history");
    assert.doesNotMatch(body, /removeItem\(\s*["']clawd-device-id["']\s*\)/, "must KEEP clawd-device-id");
  });
});

describe("pwa phone-side disconnect — Settings button wiring", () => {
  it("renders a disconnect action button in the paired branch", () => {
    assert.match(src, /id="btn-disconnect"/, "paired settings must render #btn-disconnect");
    assert.match(src, /pair_disconnect/, "button label must use the pair_disconnect i18n key");
  });

  it("exposes an onDisconnect hook and wires it to forget() + setUnpaired(true)", () => {
    assert.match(src, /onDisconnect/, "SettingsRenderer must expose an onDisconnect hook");
    assert.match(src, /connection\.forget\(\)/, "App must call connection.forget() on disconnect");
  });
});

describe("pwa i18n — disconnect strings", () => {
  it("has pair_disconnect for all 5 languages", () => {
    assert.ok(i18n.I18N.pair_disconnect, "pair_disconnect key must exist");
    for (const lang of i18n.SUPPORTED_LANGS) {
      assert.strictEqual(typeof i18n.I18N.pair_disconnect[lang], "string");
      assert.ok(i18n.I18N.pair_disconnect[lang].length > 0, `pair_disconnect.${lang} must be non-empty`);
    }
  });

  it("has a two-tap confirm string for all 5 languages", () => {
    assert.ok(i18n.I18N.pair_disconnect_confirm, "pair_disconnect_confirm key must exist");
    for (const lang of i18n.SUPPORTED_LANGS) {
      assert.ok(i18n.I18N.pair_disconnect_confirm[lang].length > 0, `pair_disconnect_confirm.${lang} must be non-empty`);
    }
  });
});

describe("pwa service worker — cache bump for the new app.js/i18n.js", () => {
  it("bumps CACHE_NAME to v15 so the updated assets ship to the installed PWA", () => {
    assert.match(sw, /clawd-mobile-v15/, "CACHE_NAME must be bumped to v15");
    assert.doesNotMatch(sw, /clawd-mobile-v14/, "old v14 cache name must be gone");
  });
});

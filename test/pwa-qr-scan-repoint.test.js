"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const pwaDir = path.join(__dirname, "..", "pwa");
const read = (f) => fs.readFileSync(path.join(pwaDir, f), "utf8");

const app = read("app.js");
const html = read("index.html");
const sw = read("sw.js");
const qrScan = read("qr-scan.js");
const jsqr = read("jsqr.js");
const i18n = require("../pwa/i18n.js");
const notice = fs.readFileSync(path.join(__dirname, "..", "NOTICE.md"), "utf8");

describe("pwa QR vendor — jsqr.js", () => {
  it("is vendored with the full MIT notice and exposes jsQR", () => {
    assert.match(jsqr, /MIT License/, "jsqr.js must carry the MIT license header");
    assert.match(jsqr, /Permission is hereby granted/, "must include the full MIT permission text");
    assert.match(jsqr, /Cosmo Wolfe/, "must credit the jsQR author");
    assert.match(jsqr, /root\["jsQR"\]|exports\["jsQR"\]/, "UMD bundle must expose jsQR");
  });
  it("is recorded in NOTICE.md", () => {
    assert.match(notice, /## jsQR/, "NOTICE.md must have a jsQR section");
    assert.match(notice, /cozmo\/jsQR/, "NOTICE.md must point at the jsQR source");
  });
});

describe("pwa QR scanner — qr-scan.js", () => {
  it("exposes a QrScanner global and decodes locally via jsQR", () => {
    assert.match(qrScan, /window\.QrScanner\s*=\s*QrScanner/, "must export window.QrScanner");
    assert.match(qrScan, /window\.jsQR/, "must decode via the vendored jsQR global");
  });
  it("uses the camera with a photo fallback (no image leaves the device)", () => {
    assert.match(qrScan, /getUserMedia/, "must try the live camera");
    assert.match(qrScan, /facingMode/, "must request the rear camera");
    assert.match(qrScan, /type="file"[^>]*accept="image\/\*"/, "must offer a photo fallback");
    assert.match(qrScan, /_fallbackToPhoto/, "must degrade to the photo path on camera failure");
  });
  it("photo fallback is a tappable button (live iOS gesture) with no forced capture", () => {
    // iOS ignores a programmatic file-input click from an async camera rejection,
    // and capture="environment" would re-open the camera the fallback exists to avoid.
    assert.doesNotMatch(qrScan, /capture="environment"/, "must not force the camera on the photo fallback");
    assert.match(qrScan, /scanner-photo-btn/, "must reveal a tappable photo button");
    assert.match(qrScan, /scan_pick_photo/, "photo button must be labeled");
    const fb = qrScan.match(/_fallbackToPhoto\(\)\s*\{[\s\S]*?\n {4}\}/);
    assert.ok(fb, "could not isolate _fallbackToPhoto");
    assert.doesNotMatch(fb[0], /\.click\(\)/, "fallback must not rely on a programmatic click (iOS drops it)");
  });
  it("bridges t()/showToast through the app globals", () => {
    assert.match(qrScan, /window\.clawdT/, "must read t() via window.clawdT");
    assert.match(qrScan, /window\.clawdToast/, "must read showToast via window.clawdToast");
  });
});

describe("pwa shell — scanner wired into the page + SW", () => {
  it("loads jsqr.js and qr-scan.js before app.js", () => {
    const iJsqr = html.indexOf("/mobile/jsqr.js");
    const iScan = html.indexOf("/mobile/qr-scan.js");
    const iApp = html.indexOf("/mobile/app.js");
    assert.ok(iJsqr > -1 && iScan > -1 && iApp > -1, "all three scripts must be present");
    assert.ok(iJsqr < iApp && iScan < iApp, "jsqr.js and qr-scan.js must load before app.js");
  });
  it("has the scanner overlay mount point", () => {
    assert.match(html, /id="scanner-overlay"/, "index.html must contain #scanner-overlay");
  });
  it("precaches the new assets in the service worker", () => {
    assert.match(sw, /\/mobile\/jsqr\.js/, "SW must precache jsqr.js");
    assert.match(sw, /\/mobile\/qr-scan\.js/, "SW must precache qr-scan.js");
  });
});

describe("pwa app — bridges + scan wiring", () => {
  it("sets the clawdT / clawdToast bridges for qr-scan.js", () => {
    assert.match(app, /window\.clawdT\s*=/, "app.js must set window.clawdT");
    assert.match(app, /window\.clawdToast\s*=/, "app.js must set window.clawdToast");
  });
  it("instantiates the scanner and binds both surfaces", () => {
    assert.match(app, /new window\.QrScanner\(\)/, "App must instantiate QrScanner");
    assert.match(app, /_bindScanner/, "App must bind the scanner");
    assert.match(app, /id="btn-scan-reconnect"/, "Settings must render a scan-reconnect button");
    assert.match(app, /id="btn-scan-cta"/, "the empty-state must render a scan CTA");
    assert.match(app, /scan_reconnect/, "scan buttons must use the scan_reconnect i18n key");
  });
});

describe("pwa app — scanned-address re-point", () => {
  it("parses the scanned URL and re-points via the durable credential", () => {
    assert.match(app, /_handleScannedText/, "must have a scanned-text handler");
    assert.match(app, /new URL\(/, "must parse the scanned text as a URL");
    assert.match(app, /repoint\(/, "must re-point the connection");
  });
  it("guards on the /mobile path so a stray QR can't steer the connection", () => {
    assert.ok(app.includes("mobile(\\/|$)"), "handler must require the /mobile path before re-pointing");
  });
  it("refuses to send the durable credential to a non-LAN host", () => {
    assert.match(app, /isLanHost/, "must classify the scanned host before re-pointing");
    assert.match(app, /scan_not_lan/, "must reject non-LAN hosts with a clear message");
    // RFC1918 + loopback + CGNAT coverage in the classifier
    assert.match(app, /a === 10 \|\| a === 127/, "must allow 10/8 and loopback");
    assert.match(app, /192 && b === 168/, "must allow 192.168/16");
    assert.match(app, /172 && b >= 16 && b <= 31/, "must allow 172.16/12");
    assert.match(app, /100 && b >= 64 && b <= 127/, "must allow CGNAT/Tailscale 100.64/10");
    // the guard must run before repoint() inside the scanned-text handler
    const h = app.match(/_handleScannedText\(text\)\s*\{[\s\S]*?\n {4}\}/);
    assert.ok(h, "could not isolate _handleScannedText");
    assert.ok(h[0].indexOf("isLanHost") < h[0].indexOf("repoint("), "LAN check must precede repoint()");
  });
  it("re-point starts with an info toast, not a premature success", () => {
    const h = app.match(/_handleScannedText\(text\)\s*\{[\s\S]*?\n {4}\}/);
    assert.match(h[0], /scan_repointed[\s\S]*?"info"/, "scanned re-point toast must be info, not success");
  });
  it("repoint() funnels through connect() (durable cred precedence stays intact)", () => {
    const m = app.match(/repoint\s*\(target\)\s*\{[\s\S]*?\n\s{4}\}/);
    assert.ok(m, "could not isolate repoint()");
    assert.match(m[0], /this\.connect\(/, "repoint must funnel through connect()");
  });
});

describe("pwa app — known-endpoint store + reconnect rotation", () => {
  it("records an endpoint only after the desktop authenticates the device", () => {
    assert.match(app, /_recordEndpoint/, "must define _recordEndpoint");
    assert.match(app, /clawd-endpoints/, "must persist to clawd-endpoints");
    assert.match(app, /_endpointRecorded/, "recording must be gated, not fired on the bare upgrade");
    assert.ok(/onmessage[\s\S]*?_recordEndpoint/.test(app), "_recordEndpoint must fire from the message path");
    // and NOT from the bare WS upgrade (onopen)
    const open = app.match(/socket\.onopen = function\(\)\s*\{[\s\S]*?\n {6}\};/);
    assert.ok(open, "could not isolate onopen");
    assert.doesNotMatch(open[0], /_recordEndpoint/, "must not record on the bare WS upgrade");
  });
  it("rotates through known endpoints on repeated reconnect failure", () => {
    assert.match(app, /_rotateTarget/, "must define _rotateTarget");
    assert.match(app, /_loadEndpoints\(\)/, "rotation must consider stored endpoints");
    assert.match(app, /retryCount % 3 === 0/, "rotation must trigger on the retry cadence");
  });
  it("guards the async rotation against clobbering a fresh foreground/scan reconnect", () => {
    assert.match(app, /_connectSeq/, "must track a connect generation id");
    // the rotation .then must bail when a newer attempt superseded it
    assert.match(app, /_connectSeq !== seq/, "rotation must bail if a newer attempt started");
  });
  it("bounds the connect attempt so a dead address can't hang the socket", () => {
    assert.match(app, /Connect timed out/, "must time out a stuck connect");
  });
  it("clears clawd-endpoints on local forget", () => {
    const m = app.match(/forget\s*\(\s*\)\s*\{[\s\S]*?\n\s{4}\}/);
    assert.ok(m, "could not isolate forget()");
    assert.match(m[0], /removeItem\(\s*["']clawd-endpoints["']\s*\)/, "forget must drop clawd-endpoints");
  });
  it("never targets info.lanIp (keeps location.hostname for the cert SAN)", () => {
    assert.doesNotMatch(app, /host\s*[:=]\s*info\.lanIp/, "must not target info.lanIp");
  });
});

describe("pwa i18n — scanner strings (5 languages)", () => {
  const keys = ["scan_reconnect", "scan_title", "scan_cancel", "scan_hint", "scan_photo_hint",
    "scan_camera_denied", "scan_invalid", "scan_pick_photo", "scan_unsupported", "scan_not_lan", "scan_repointed"];
  for (const key of keys) {
    it(`has ${key} for all 5 languages`, () => {
      assert.ok(i18n.I18N[key], `${key} must exist`);
      for (const lang of i18n.SUPPORTED_LANGS) {
        assert.strictEqual(typeof i18n.I18N[key][lang], "string");
        assert.ok(i18n.I18N[key][lang].length > 0, `${key}.${lang} must be non-empty`);
      }
    });
  }
  it("scan_repointed keeps the {addr} placeholder in every language", () => {
    for (const lang of i18n.SUPPORTED_LANGS) {
      assert.match(i18n.I18N.scan_repointed[lang], /\{addr\}/, `scan_repointed.${lang} must keep {addr}`);
    }
  });
});

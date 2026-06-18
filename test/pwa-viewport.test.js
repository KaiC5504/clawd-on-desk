"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", "pwa", f), "utf8");

describe("pwa viewport — zoom is locked", () => {
  it("the viewport meta disables user scaling", () => {
    const tag = (read("index.html").match(/<meta[^>]*name=["']viewport["'][^>]*>/i) || [])[0];
    assert.ok(tag, "a viewport meta tag must exist");
    assert.match(tag, /user-scalable\s*=\s*no/i, "viewport must set user-scalable=no");
    assert.match(tag, /maximum-scale\s*=\s*1/i, "viewport must pin maximum-scale=1");
  });

  it("touch-action disables double-tap zoom on the document", () => {
    assert.match(read("style.css"), /touch-action\s*:\s*manipulation/i,
      "html/body should set touch-action: manipulation to kill double-tap zoom");
  });

  // Safari ignores user-scalable=no for accessibility, so pinch must be blocked in JS.
  it("app.js blocks iOS pinch-zoom gesture events", () => {
    assert.match(read("app.js"), /gesturestart/,
      "app.js must preventDefault on Safari gesture events to block pinch-zoom");
  });
});

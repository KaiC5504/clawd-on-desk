"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const css = fs.readFileSync(path.join(__dirname, "..", "pwa", "style.css"), "utf8");

describe("pwa type scale — fluid rem base", () => {
  it("the root font-size is fluid (clamp) so text scales with screen width", () => {
    assert.match(css, /font-size:\s*clamp\(\s*15px[^;]*16\.5px\s*\)/,
      "html/body font-size should be clamp(15px, …, 16.5px)");
  });

  it("readable text is sized in rem, not fixed px (only the fixed code box keeps px)", () => {
    const pxSizes = css.match(/font-size:\s*\d[\d.]*px/g) || [];
    // The OTP code box is fixed-width chrome on a narrow row, so it keeps a px font.
    const offenders = pxSizes.filter((d) => !/\b20px\b/.test(d));
    assert.deepStrictEqual(offenders, [],
      "text font-sizes should be rem-based; found fixed px: " + offenders.join(", "));
  });
});

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "pwa", "app.js"), "utf8");

// The plan body renders agent markdown through mdToHtml() rather than dumping the raw
// source. mdToHtml/mdInline/mdEmphasis are pure string functions, so we lift them out of
// the IIFE and exercise the real implementation (no DOM needed) with an esc() shim that
// matches app.js's DOM-based esc — escapes <>& only, leaves quotes alone.
function loadRenderer() {
  const start = app.indexOf("function mdToHtml(src) {");
  const end = app.indexOf("// The desktop is always reachable");
  assert.ok(start !== -1 && end > start, "mdToHtml block must be present in app.js");
  const block = app.slice(start, end);
  const esc = (str) => String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return new Function("esc", block + "\n return mdToHtml;")(esc);
}
const md = loadRenderer();

describe("pwa plan body — wiring", () => {
  it("renders the plan through mdToHtml, not raw esc()", () => {
    assert.match(app, /class="approval-plan approval-md">' \+ mdToHtml\(a\.plan \|\| a\.detail \|\| ""\)/);
  });
  it("renders the read-only (unpaired/insecure) plan through mdToHtml too", () => {
    assert.match(app, /class="approval-plan approval-md">' \+ mdToHtml\(a\.plan \|\| ""\)/);
  });
});

describe("pwa plan markdown — block rendering", () => {
  it("renders ATX headings h1–h6", () => {
    assert.match(md("# Title"), /<h1 class="approval-md-h approval-md-h1">Title<\/h1>/);
    assert.match(md("### Sub"), /<h3 class="approval-md-h approval-md-h3">Sub<\/h3>/);
    assert.match(md("###### Deep"), /<h6[^>]*>Deep<\/h6>/);
  });

  it("renders unordered and ordered lists", () => {
    assert.match(md("- one\n- two"), /<ul class="approval-md-list"><li>one<\/li><li>two<\/li><\/ul>/);
    assert.match(md("1. a\n2. b"), /<ol class="approval-md-list"><li>a<\/li><li>b<\/li><\/ol>/);
  });

  it("renders blockquotes, horizontal rules and paragraphs", () => {
    assert.match(md("> quoted"), /<blockquote class="approval-md-bq">quoted<\/blockquote>/);
    assert.match(md("---"), /<hr class="approval-md-hr">/);
    assert.match(md("plain text"), /<p class="approval-md-p">plain text<\/p>/);
  });

  it("renders GFM tables", () => {
    const out = md("| a | b |\n| - | - |\n| 1 | 2 |");
    assert.match(out, /<table class="approval-md-table">/);
    assert.match(out, /<th>a<\/th><th>b<\/th>/);
    assert.match(out, /<td>1<\/td><td>2<\/td>/);
  });

  it("renders fenced code blocks with the content HTML-escaped, not formatted", () => {
    const out = md("```js\nconst x = 1 < 2 && a > b;\n```");
    assert.match(out, /<pre class="approval-md-pre"><code>const x = 1 &lt; 2 &amp;&amp; a &gt; b;<\/code><\/pre>/);
  });
});

describe("pwa plan markdown — inline rendering", () => {
  it("renders bold, italic, inline code and strikethrough", () => {
    assert.match(md("**b**"), /<strong>b<\/strong>/);
    assert.match(md("*i*"), /<em>i<\/em>/);
    assert.match(md("`c`"), /<code class="approval-md-code">c<\/code>/);
    assert.match(md("~~s~~"), /<del>s<\/del>/);
  });

  it("does NOT treat underscores as italics (snake_case / __dunder__ stay intact)", () => {
    const out = md("call run_tests and __init__ now");
    assert.match(out, /run_tests/);
    assert.match(out, /__init__/);
    assert.doesNotMatch(out, /<em>/);
  });

  it("leaves emphasis markers inside inline code untouched", () => {
    assert.match(md("`a*b*c`"), /<code class="approval-md-code">a\*b\*c<\/code>/);
  });

  it("renders http(s)/mailto links and escapes ampersands in the href", () => {
    assert.match(md("[d](https://x.io/a?p=1&q=2)"), /<a href="https:\/\/x\.io\/a\?p=1&amp;q=2" target="_blank" rel="noopener">d<\/a>/);
  });
});

describe("pwa plan markdown — XSS safety (agent text is escape-first)", () => {
  it("escapes raw HTML so it cannot execute", () => {
    const out = md("hi <script>alert(1)</script> <img src=x onerror=alert(1)>");
    // The tags themselves must be escaped to inert text — an onerror= substring is
    // harmless once it lives inside &lt;img&gt; rather than a real element.
    assert.doesNotMatch(out, /<script>/);
    assert.doesNotMatch(out, /<img/);
    assert.match(out, /&lt;script&gt;/);
    assert.match(out, /&lt;img/);
  });

  it("strips non-http(s)/mailto link schemes (javascript:, data:)", () => {
    assert.doesNotMatch(md("[x](javascript:alert(1))"), /href="javascript:/);
    assert.doesNotMatch(md("[x](data:text/html;base64,abc)"), /href="data:/);
  });

  it("percent-encodes quotes in a link href so the attribute can't break out", () => {
    const out = md('[x](https://a"onmouseover="alert(1))');
    assert.doesNotMatch(out, /href="https:\/\/a"on/);
    assert.match(out, /%22/);
  });
});

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "pwa", "app.js"), "utf8");

describe("pwa approval question renderer", () => {
  it("renders checkbox inputs for multi-select and radios otherwise", () => {
    assert.match(app, /q\.multiSelect \? "checkbox" : "radio"/);
  });

  it("renders an 'Other' option that reveals a free-text area", () => {
    assert.match(app, /q\.allowOther !== false/);
    assert.match(app, /data-other="1"/);
    assert.match(app, /data-other-text="/);
    assert.match(app, /approval_other_placeholder/);
    // selecting Other toggles the textarea visibility
    assert.match(app, /function syncOther\(\)/);
    assert.match(app, /ta\.classList\.remove\("hidden"\)/);
  });

  it("submits an index-based selections payload (phone stays dumb)", () => {
    assert.match(app, /action: "elicitation-submit", selections: selections/);
    assert.match(app, /questionIndex: qi, optionIndices: optionIndices, otherText: otherText/);
    // optionIndices come from the checked option inputs, not echoed text
    assert.match(app, /input\[data-opt\][\s\S]*?if \(inp\.checked\) optionIndices\.push/);
  });

  it("scrolls a focused free-text area into view (iOS keyboard mitigation)", () => {
    assert.match(app, /_scrollIntoView\(/);
    assert.match(app, /scrollIntoView\(\{ block: "center" \}\)/);
  });
});

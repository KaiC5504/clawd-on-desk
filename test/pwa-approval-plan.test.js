"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "pwa", "app.js"), "utf8");

describe("pwa approval plan renderer", () => {
  it("renders the plan text and Approve / Reject actions", () => {
    assert.match(app, /approval_approve/);
    assert.match(app, /approval_reject/);
    assert.match(app, /class="approval-plan approval-md"/);
  });

  it("maps Approve to allow and Reject to deny", () => {
    assert.match(app, /this\.getAttribute\("data-act"\) === "allow" \? "allow" : "deny"/);
  });

  it("reveals a feedback textarea via 'Suggest changes' and sends plan-feedback", () => {
    assert.match(app, /approval_suggest_changes/);
    assert.match(app, /id="approval-feedback"/);
    assert.match(app, /action: "plan-feedback", feedback: text/);
  });

  it("does not send empty feedback (which would mean go-to-terminal)", () => {
    assert.match(app, /if \(!text\) \{ fb\.focus\(\); return; \}/);
  });
});

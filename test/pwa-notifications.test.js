"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "pwa", "app.js"), "utf8");

// Source-regex style (the PWA has no DOM harness): isolate NotificationManager's
// onStateChange body and assert the lock-screen banners stay clean — no agent
// name, no body that just echoes the title.
function onStateChangeBody() {
  const start = app.indexOf("onStateChange(sessionId, data) {");
  assert.ok(start !== -1, "onStateChange must exist");
  const end = app.indexOf("_notify(title, body, tag) {", start);
  assert.ok(end > start, "could not isolate onStateChange body");
  return app.slice(start, end);
}

describe("pwa session-state notifications — clean, content-free banners", () => {
  const body = onStateChangeBody();

  it("never puts the agent id in the notification (the user knows what they launched)", () => {
    assert.doesNotMatch(body, /agentId/, "must not fall back to the agent id");
    assert.doesNotMatch(body, /"Agent"/, "must not fall back to a literal 'Agent' label");
  });

  it("labels with the session title only", () => {
    assert.match(body, /var label = data\.title \|\| ""/, "label must be the session title (or empty)");
  });

  it("does not redundantly echo the state label into the attention/error body", () => {
    assert.doesNotMatch(body, /label \+ " - " \+ t\(config\.labelKey\)/,
      "attention/error body must not repeat the title");
  });

  it("omits the task-done body when the session is untitled (no empty-label sentence)", () => {
    assert.match(body, /label \? t\("notif_task_done_body"/,
      "task-done body must be guarded on a present label");
  });
});

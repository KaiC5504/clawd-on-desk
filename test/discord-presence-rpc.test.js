"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  resolvePresenceState,
  presenceImageUrl,
  buildPresencePayload,
  encodeFrame,
  decodeFrames,
  OP,
} = require("../src/discord-presence-rpc");

test("resolvePresenceState maps active states and recovers done/error from the badge", () => {
  assert.strictEqual(resolvePresenceState({ state: "thinking" }), "thinking");
  assert.strictEqual(resolvePresenceState({ state: "working" }), "working");
  assert.strictEqual(resolvePresenceState({ state: "juggling" }), "juggling");
  assert.strictEqual(resolvePresenceState({ state: "mini-working" }), "working"); // mini-* shares its base
  // one-shot states (error/attention/notification/...) collapse to idle in the
  // snapshot; the badge is how we recover them
  assert.strictEqual(resolvePresenceState({ state: "idle", badge: "interrupted" }), "error");
  assert.strictEqual(resolvePresenceState({ state: "idle", badge: "done" }), "attention");
  assert.strictEqual(resolvePresenceState({ state: "idle", requiresCompletionAck: true }), "attention");
  assert.strictEqual(resolvePresenceState({ state: "working", requiresCompletionAck: true }), "working"); // busy now wins
  assert.strictEqual(resolvePresenceState({ state: "idle" }), "idle");
  assert.strictEqual(resolvePresenceState(null), "idle");
});

test("buildPresencePayload exposes ONLY agent + coarse state + sprite by default", () => {
  const session = {
    agentId: "claude-code",
    state: "working",
    cwd: "D:\\Repos\\Apps\\secret-project",
    sessionTitle: "fix the thing",
  };
  const out = buildPresencePayload(session, { privacyShowProject: false });
  const blob = JSON.stringify(out);
  assert.strictEqual(blob.includes("secret-project"), false); // cwd / project never leaks by default
  assert.strictEqual(blob.includes("fix the thing"), false);  // session title never leaks
  assert.match(out.state, /working/i);            // coarse state present
  assert.ok(out.details);                         // agent label present
  assert.ok(out.assets && out.assets.large_image); // sprite present
});

test("large_image + label follow the resolved presence state", () => {
  const img = (s) => buildPresencePayload(s, {}).assets.large_image;
  const label = (s) => buildPresencePayload(s, {}).state;
  assert.match(img({ state: "thinking" }), /clawd-thinking\.gif$/);
  assert.match(img({ state: "working" }), /clawd-typing\.gif$/);
  assert.match(img({ state: "juggling" }), /clawd-juggling\.gif$/);
  assert.match(img({ state: "idle", badge: "interrupted" }), /clawd-error\.gif$/);
  assert.match(img({ state: "idle", requiresCompletionAck: true }), /clawd-happy\.gif$/);
  assert.match(img({ state: "idle" }), /clawd-idle\.gif$/);
  assert.strictEqual(label({ state: "idle", requiresCompletionAck: true }), "Waiting for input");
  assert.strictEqual(label({ state: "idle", badge: "interrupted" }), "Error");
  assert.match(presenceImageUrl("totally-unknown"), /clawd-idle\.gif$/); // unknown falls back to idle
});

test("buildPresencePayload adds the project name ONLY when privacyShowProject is on", () => {
  const session = { agentId: "claude-code", state: "working", cwd: "D:\\Repos\\Apps\\demo" };
  const off = buildPresencePayload(session, { privacyShowProject: false });
  assert.strictEqual(JSON.stringify(off).includes("demo"), false);
  const on = buildPresencePayload(session, { privacyShowProject: true });
  assert.strictEqual(JSON.stringify(on).includes("demo"), true);
});

test("encodeFrame/decodeFrames round-trips opcode + JSON across split chunks", () => {
  const payload = { v: 1, client_id: "123456789012345678" };
  const frame = encodeFrame(OP.HANDSHAKE, payload);
  // header is 8 bytes: int32-LE opcode + int32-LE length
  assert.strictEqual(frame.readInt32LE(0), OP.HANDSHAKE);
  assert.strictEqual(frame.readInt32LE(4), Buffer.byteLength(JSON.stringify(payload)));
  // feed it in two pieces to prove the accumulator reassembles split pipe reads
  const dec = decodeFrames(Buffer.concat([frame.subarray(0, 3), frame.subarray(3)]));
  assert.strictEqual(dec.frames.length, 1);
  assert.strictEqual(dec.frames[0].op, OP.HANDSHAKE);
  assert.deepStrictEqual(dec.frames[0].data, payload);
  assert.strictEqual(dec.rest.length, 0);
});

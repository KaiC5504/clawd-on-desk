"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  toCoarseState,
  buildPresencePayload,
  encodeFrame,
  decodeFrames,
  OP,
} = require("../src/discord-presence-rpc");

test("toCoarseState collapses canonical session states into 4 coarse buckets", () => {
  assert.strictEqual(toCoarseState("working"), "working");
  assert.strictEqual(toCoarseState("juggling"), "working");
  assert.strictEqual(toCoarseState("carrying"), "working");
  assert.strictEqual(toCoarseState("thinking"), "thinking");
  assert.strictEqual(toCoarseState("notification"), "waiting"); // permission pending => waiting on user
  assert.strictEqual(toCoarseState("attention"), "waiting");
  assert.strictEqual(toCoarseState("error"), "waiting");        // highest-priority state; it dominates the display
  assert.strictEqual(toCoarseState("idle"), "idle");
  assert.strictEqual(toCoarseState("sleeping"), "idle");
  assert.strictEqual(toCoarseState("mini-working"), "working"); // tolerate a leaked mini-* just in case
});

test("buildPresencePayload exposes ONLY agent + coarse state + icon by default", () => {
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
  assert.ok(out.assets && out.assets.large_image); // icon present
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

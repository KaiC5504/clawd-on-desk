"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  toCoarseState,
  buildPresencePayload,
  pickDominantSession,
  encodeFrame,
  decodeFrames,
  createDiscordPresenceBridge,
  OP,
} = require("../src/discord-presence-rpc");

// Stand-in for a Discord IPC pipe socket: captures writes, driven by emit().
class FakeIpcSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.destroyed = false;
  }
  write(buf) { this.writes.push(buf); return true; }
  destroy() { this.destroyed = true; }
}

function firstFrame(socket) {
  return decodeFrames(socket.writes[0]).frames[0];
}

const READY_FRAME = encodeFrame(OP.FRAME, { cmd: "DISPATCH", evt: "READY" });

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

test("buildPresencePayload publishes ONLY the folder name, never a full path, on any OS", () => {
  // POSIX path.basename can't split a Windows cwd, leaking the whole path; the
  // payload must surface just the folder name regardless of host platform.
  const session = { agentId: "claude-code", state: "working", cwd: "C:\\Users\\alice\\Projects\\secret" };
  const out = buildPresencePayload(session, { privacyShowProject: true });
  assert.match(out.state, /secret/);
  assert.strictEqual(out.state.includes("alice"), false);
  assert.strictEqual(out.state.includes("Projects"), false);
  assert.strictEqual(out.state.includes("C:"), false);
  assert.strictEqual(out.state.includes("\\"), false);
  assert.strictEqual(out.state.includes("/"), false);
});

test("pickDominantSession skips headless, sleeping, and hiddenFromHud sessions (HUD-aligned)", () => {
  const snapshot = { sessions: [
    { id: "a", agentId: "codex", state: "working", hiddenFromHud: true },  // superseded -> skip despite high priority
    { id: "b", agentId: "claude-code", state: "sleeping" },                // ended -> skip
    { id: "c", agentId: "claude-code", state: "error", headless: true },   // headless -> skip
    { id: "d", agentId: "claude-code", state: "thinking" },                // visible -> picked
  ] };
  const picked = pickDominantSession(snapshot);
  assert.strictEqual(picked && picked.id, "d");

  const allHidden = { sessions: [
    { id: "x", state: "working", hiddenFromHud: true },
    { id: "y", state: "sleeping" },
    { id: "z", state: "error", headless: true },
  ] };
  assert.strictEqual(pickDominantSession(allHidden), null);
});

test("bridge reconnects with the new client_id when the App ID changes while connected", () => {
  const cfg = { enabled: true, applicationId: "111111111111111111", privacyShowProject: false };
  const sockets = [];
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { const s = new FakeIpcSocket(); sockets.push(s); return s; },
  });

  bridge.start();
  assert.strictEqual(sockets.length, 1);
  sockets[0].emit("connect");                       // pipe up -> HANDSHAKE sent
  const hs1 = firstFrame(sockets[0]);
  assert.strictEqual(hs1.op, OP.HANDSHAKE);
  assert.strictEqual(hs1.data.client_id, "111111111111111111");
  sockets[0].emit("data", READY_FRAME);             // READY -> connected

  cfg.applicationId = "222222222222222222";
  bridge.start();                                   // App ID changed while live
  assert.strictEqual(sockets.length, 2);            // forced a fresh dial
  assert.strictEqual(sockets[0].destroyed, true);   // old socket torn down, not leaked
  sockets[1].emit("connect");
  assert.strictEqual(firstFrame(sockets[1]).data.client_id, "222222222222222222");

  bridge.stop();
});

test("bridge does NOT reconnect when start() runs with an unchanged App ID", () => {
  const cfg = { enabled: true, applicationId: "111111111111111111" };
  const sockets = [];
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { const s = new FakeIpcSocket(); sockets.push(s); return s; },
  });

  bridge.start();
  sockets[0].emit("connect");
  sockets[0].emit("data", READY_FRAME);
  bridge.start();                                   // same config -> no-op
  assert.strictEqual(sockets.length, 1);

  bridge.stop();
});

test("bridge supersedes an in-flight dial when the App ID changes mid-connect (no orphan)", () => {
  const cfg = { enabled: true, applicationId: "111111111111111111" };
  const sockets = [];
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { const s = new FakeIpcSocket(); sockets.push(s); return s; },
  });

  bridge.start();                       // dial #1 in flight, not yet connected
  assert.strictEqual(sockets.length, 1);

  cfg.applicationId = "222222222222222222";
  bridge.start();                       // App ID changed mid-dial -> supersede
  assert.strictEqual(sockets.length, 2);
  assert.strictEqual(sockets[0].destroyed, true);  // in-flight dial torn down

  // The superseded socket connecting late must NOT adopt or send a handshake.
  sockets[0].emit("connect");
  assert.strictEqual(sockets[0].writes.length, 0);

  sockets[1].emit("connect");
  assert.strictEqual(firstFrame(sockets[1]).data.client_id, "222222222222222222");

  bridge.stop();
});

test("bridge recovers when the dial throws synchronously (e.g. fd exhaustion)", () => {
  const cfg = { enabled: true, applicationId: "111111111111111111" };
  let dials = 0;
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { dials += 1; throw new Error("EMFILE"); },
  });

  // Must not throw, and must not wedge `connecting=true` — a later start() can re-dial.
  assert.doesNotThrow(() => bridge.start());
  assert.strictEqual(dials, 1);

  bridge.stop();
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

"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const WebSocket = require("ws");
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { initMobilePreviewServer, PROTOCOL_VERSION, buildPushNotification } = require("../src/network/mobile-preview-server");

function waitForMessage(ws, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === type) {
          clearTimeout(timer);
          ws.removeListener("message", handler);
          resolve(msg);
        }
      } catch {}
    };
    ws.on("message", handler);
  });
}

function connectClient(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  const messages = [];
  const waiters = [];
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      messages.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].type === msg.type) {
          const w = waiters.splice(i, 1)[0];
          w.resolve(msg);
        }
      }
    } catch {}
  });
  return {
    ws,
    waitFor(type, timeoutMs = 5000) {
      const existing = messages.find((m) => m.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
        waiters.push({ type, resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
      });
    },
    close() { ws.close(); },
  };
}

function waitForOpen(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error("Timeout waiting for open")), timeoutMs);
    ws.once("open", () => { clearTimeout(timer); resolve(); });
  });
}

function waitForPort(getPortFn, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const p = getPortFn();
      if (typeof p === "number" && p > 0) { resolve(p); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error("Timeout waiting for port")); return; }
      setTimeout(check, 50);
    };
    check();
  });
}

function httpGet(port, pathStr) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: pathStr }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on("error", reject);
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "0.0.0.0", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

function occupy(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(port, "0.0.0.0", () => resolve(srv));
  });
}

// The server now binds the EXACT configured port (no range-walk). A real clawd
// instance on the default 23334 would otherwise collide with these suites, so the
// wrapper pins an OS-assigned ephemeral port (set per-suite in before()) unless
// the test chose its own. Servers that restart within a suite rebind the same
// port; the bound port is read back via start()'s return / server.getPort().
let TEST_HTTP_PORT = 23334;
function initServer(ctx) {
  const userSnap = ctx && ctx.getSettingsSnapshot;
  return initMobilePreviewServer({
    ...ctx,
    getSettingsSnapshot: () => {
      const snap = userSnap ? userSnap() : {};
      return Number.isInteger(snap.mobilePort) ? snap : { ...snap, mobilePort: TEST_HTTP_PORT };
    },
  });
}

describe("buildPushNotification — clean, content-free banners", () => {
  it("titles each kind without the agent name and never leaks the prompt body", () => {
    const plan = buildPushNotification({ kind: "plan", title: "claude-code shared a plan", detail: "Step 1\nStep 2..." });
    assert.strictEqual(plan.title, "Plan ready to review");
    assert.ok(!/claude-code/i.test(plan.title + plan.body), "must not name the agent");
    assert.ok(!/Step 1/.test(plan.body), "must not dump the plan content into the banner");

    const question = buildPushNotification({ kind: "question", title: "claude-code asks a question", detail: "Pick a color" });
    assert.strictEqual(question.title, "A question for you");
    assert.ok(!/Pick a color/.test(question.body), "must not dump the question text");

    const approval = buildPushNotification({ kind: "approval", title: "claude-code requests Bash", detail: "Agent: claude-code\nTool: Bash" });
    assert.strictEqual(approval.title, "Approval needed");
    assert.ok(!/claude-code|Tool:/.test(approval.body), "must not dump the tool summary");
  });

  it("defaults a kind-less payload (classic approval) to the approval banner", () => {
    const note = buildPushNotification({ title: "x", detail: "y" });
    assert.strictEqual(note.title, "Approval needed");
    assert.ok(note.body.length > 0);
  });

  it("survives a null/garbage payload without throwing", () => {
    assert.strictEqual(buildPushNotification(null).title, "Approval needed");
    assert.strictEqual(buildPushNotification(undefined).title, "Approval needed");
  });
});

function waitForClose(ws, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    ws.on("close", (code) => { clearTimeout(timer); resolve(code); });
  });
}

// ── Original test suite (adapted to use injectable tokenPath) ──

describe("Mobile Preview Server", () => {
  let server;
  let port;
  let token;
  const sessions = new Map();
  let pendingPermissions = [];
  let tmpTokenDir;

  function createSession(sid, state, agentId) {
    sessions.set(sid, {
      state,
      agentId,
      cwd: "/home/user/project",
      sessionTitle: `Session ${sid}`,
      updatedAt: Date.now(),
      recentEvents: [],
    });
  }

  before(async () => {
    tmpTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-test-"));
    const freePort = await getFreePort();
    server = initServer({
      sessions,
      getSettingsSnapshot: () => ({ mobilePort: freePort }),
      getPendingPermissions: () => pendingPermissions,
      tokenPath: path.join(tmpTokenDir, "mobile-token.json"),
    });
    port = await server.start();
    token = server.getToken();
  });

  after(() => {
    server.cleanup();
    sessions.clear();
    pendingPermissions = [];
    try { fs.rmSync(tmpTokenDir, { recursive: true }); } catch {}
  });

  it("protocol version is v2", () => {
    assert.strictEqual(PROTOCOL_VERSION, "v2");
    assert.strictEqual(server.PROTOCOL_VERSION, "v2");
  });

  it("starts and listens on a port", () => {
    assert.ok(typeof port === "number" && port >= 23334);
  });

  it("serves PWA static files", async () => {
    const res = await httpGet(port, "/mobile/");
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes("Clawd Mobile"));
    assert.ok(res.headers["content-type"].includes("text/html"));
  });

  it("serves public connection info without exposing the token", async () => {
    const res = await httpGet(port, "/api/connection-info");
    assert.strictEqual(res.status, 200);
    const info = JSON.parse(res.body);
    assert.strictEqual(info.status, "ok");
    assert.strictEqual(info.port, port);
    assert.strictEqual(typeof info.lanIp, "string");
    assert.ok(!("token" in info));
  });

  it("returns 404 for non-mobile paths", async () => {
    const res = await httpGet(port, "/other");
    assert.strictEqual(res.status, 404);
  });

  it("rejects path traversal attempts instead of serving files outside the PWA directory", async () => {
    const dotDot = await httpGet(port, "/mobile/%2e%2e/package.json");
    assert.notStrictEqual(dotDot.status, 200);

    const encodedSlash = await httpGet(port, "/mobile/%2e%2e%2fpackage.json");
    assert.notStrictEqual(encodedSlash.status, 200);
  });

  it("rejects WebSocket with invalid token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=bad`);
    const code = await new Promise((resolve) => {
      ws.on("close", (c) => resolve(c));
      ws.on("open", () => {});
    });
    assert.strictEqual(code, 1008);
  });

  it("connects with valid token and receives snapshot", async () => {
    createSession("s1", "working", "claude-code");
    server.onSnapshot(); // Prime cache before connecting

    const client = connectClient(port, token);
    await waitForOpen(client.ws);
    const snapshot = await client.waitFor("snapshot");

    assert.strictEqual(snapshot.version, "v2");
    assert.ok(snapshot.timestamp > 0);
    assert.ok(snapshot.sessions.s1);
    assert.strictEqual(snapshot.sessions.s1.state, "working");
    assert.strictEqual(snapshot.sessions.s1.agentId, "claude-code");
    assert.strictEqual(snapshot.sessions.s1.title, "Session s1");
    assert.strictEqual(snapshot.sessions.s1.basename, "project");
    assert.strictEqual(typeof snapshot.sessions.s1.updatedAt, "number");

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("keeps agentId separate when a session has no title", async () => {
    sessions.set("s-titleless", {
      state: "working",
      agentId: "codex",
      cwd: "/home/user/titleless",
      sessionTitle: null,
      updatedAt: Date.now(),
      recentEvents: [],
    });
    server.onSnapshot();

    const client = connectClient(port, token);
    await waitForOpen(client.ws);
    const snapshot = await client.waitFor("snapshot");

    assert.ok(snapshot.sessions["s-titleless"]);
    assert.strictEqual(snapshot.sessions["s-titleless"].agentId, "codex");
    assert.strictEqual(snapshot.sessions["s-titleless"].title, null);
    assert.strictEqual(typeof snapshot.sessions["s-titleless"].updatedAt, "number");

    client.close();
    sessions.delete("s-titleless");
    server.onSnapshot();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("broadcasts state changes", async () => {
    const client = connectClient(port, token);
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");

    // Change session state
    sessions.get("s1").state = "thinking";
    sessions.get("s1").updatedAt = Date.now();
    server.onSnapshot();

    const stateMsg = await client.waitFor("state");
    assert.strictEqual(stateMsg.version, "v2");
    assert.strictEqual(stateMsg.sessionId, "s1");
    assert.strictEqual(stateMsg.data.state, "thinking");

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("broadcasts session deletions", async () => {
    const client = connectClient(port, token);
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");

    sessions.delete("s1");
    server.onSnapshot();

    const delMsg = await client.waitFor("session_deleted");
    assert.strictEqual(delMsg.version, "v2");
    assert.strictEqual(delMsg.sessionId, "s1");

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });
});

// ── Token Rotation Tests ──

describe("Token Rotation", () => {
  let tmpTokenDir;
  let server;
  let port;
  let tokenFile;
  const sessions = new Map();

  before(async () => {
    TEST_HTTP_PORT = await getFreePort();
    tmpTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-rotate-"));
    tokenFile = path.join(tmpTokenDir, "token.json");
    server = initServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();
  });

  after(() => {
    server.cleanup();
    sessions.clear();
    try { fs.rmSync(tmpTokenDir, { recursive: true }); } catch {}
  });

  it("grace-period acceptance: old token accepted within grace window", async () => {
    // Read the current token file, set up a rotated state with grace
    const currentToken = server.getToken();
    const state = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    const rotatedToken = "aabbccdd".repeat(4);
    state.previous = state.token;
    state.token = rotatedToken;
    state.graceUntil = Date.now() + 300000; // 5 min from now
    state.rotatedAt = Date.now();
    fs.writeFileSync(tokenFile, JSON.stringify(state, null, 2));

    // Reload server with the rotated state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();

    // Old token (previous) should be accepted within grace window
    const client = connectClient(port, currentToken);
    await waitForOpen(client.ws);
    const snapshot = await client.waitFor("snapshot");
    assert.ok(snapshot.version);

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("grace-period rejection: old token rejected after grace expires", async () => {
    // Set up rotated state where grace has expired
    const currentToken = server.getToken();
    const state = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    const rotatedToken = "11223344".repeat(4);
    state.previous = state.token;
    state.token = rotatedToken;
    state.graceUntil = Date.now() - 1; // grace expired
    state.rotatedAt = Date.now() - 300000;
    fs.writeFileSync(tokenFile, JSON.stringify(state, null, 2));

    // Reload with expired grace
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();

    // Old token should be rejected
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${currentToken}`);
    const code = await waitForClose(ws);
    assert.strictEqual(code, 1008);
    await new Promise((r) => setTimeout(r, 100));
  });

  it("explicit regenerate: old token immediately invalid, new token works", async () => {
    // Reload fresh token state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();
    const oldToken = server.getToken();

    // Connect a client with old token
    const client = connectClient(port, oldToken);
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");

    // Regenerate — should kick the client
    const newToken = server.regenerateToken();
    assert.notStrictEqual(newToken, oldToken);
    assert.strictEqual(newToken.length, 32);

    // Old client should get kicked
    const closeCode = await waitForClose(client.ws);
    assert.strictEqual(closeCode, 1008);

    // Old token should be rejected
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${oldToken}`);
    const code2 = await waitForClose(ws2);
    assert.strictEqual(code2, 1008);

    // New token should work
    const client3 = connectClient(port, newToken);
    await waitForOpen(client3.ws);
    const snapshot = await client3.waitFor("snapshot");
    assert.ok(snapshot.version);

    client3.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("explicit reset: all clients disconnected, new token works", async () => {
    // Reload fresh token state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();
    const oldToken = server.getToken();

    // Connect a client
    const client1 = connectClient(port, oldToken);
    await waitForOpen(client1.ws);
    await client1.waitFor("snapshot");

    // Reset — should kick the client
    const newToken = server.resetMobileAccess();
    assert.notStrictEqual(newToken, oldToken);

    const close1 = await waitForClose(client1.ws);
    assert.strictEqual(close1, 1008);

    // New token should work
    const client2 = connectClient(port, newToken);
    await waitForOpen(client2.ws);
    const snapshot = await client2.waitFor("snapshot");
    assert.ok(snapshot.version);

    client2.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("unacked rotation: server state already committed before ack", async () => {
    // Reload fresh token state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();

    // Trigger explicit regeneration (no grace — simulates unacked auto-rotation)
    const newToken = server.regenerateToken();

    // Read the file — it should already have the new token persisted
    const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(persisted.token, newToken);
    assert.strictEqual(persisted.previous, null); // regenerate clears previous

    // No ack was sent — but server state is committed
    await new Promise((r) => setTimeout(r, 100));
  });

  it("old M1 file compat: loads bare { token } format", async () => {
    // Write old M1 format (just { token })
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    const oldToken = "abcdef01".repeat(4); // 32 hex chars
    fs.writeFileSync(tokenFile, JSON.stringify({ token: oldToken }, null, 2));

    server = initServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();
    const loadedToken = server.getToken();

    // Should load the existing token
    assert.strictEqual(loadedToken, oldToken);

    // File should now have the new format with defaults
    const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(persisted.token, oldToken);
    assert.strictEqual(persisted.previous, null);
    assert.strictEqual(persisted.graceUntil, null);
    assert.ok(persisted.rotatedAt > 0, "rotatedAt should be set to current time on migration");

    // Should connect fine
    const client = connectClient(port, loadedToken);
    await waitForOpen(client.ws);
    const snapshot = await client.waitFor("snapshot");
    assert.ok(snapshot.version);

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("token_rotate message: client receives token_rotate on rotation", async () => {
    // Reload fresh token state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();
    const oldToken = server.getToken();

    // Connect a client
    const client = connectClient(port, oldToken);
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");

    // Regenerate kicks clients (different from auto-rotation broadcast).
    // Verify the regeneration works correctly.
    const newToken = server.regenerateToken();

    // Client should be kicked
    const closeCode = await waitForClose(client.ws);
    assert.strictEqual(closeCode, 1008);

    // Verify the new token is valid
    assert.strictEqual(newToken.length, 32);
    assert.strictEqual(server.getToken(), newToken);
    await new Promise((r) => setTimeout(r, 100));
  });

  it("token_rotate_ack: server accepts ack without error", async () => {
    // Reload fresh token state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();
    const token = server.getToken();

    // Connect a client
    const client = connectClient(port, token);
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");

    // Send a token_rotate_ack — server should accept it silently
    client.ws.send(JSON.stringify({ type: "token_rotate_ack" }));

    // Wait a bit — no error, no disconnect
    await new Promise((r) => setTimeout(r, 500));

    // Client should still be connected (not kicked)
    assert.strictEqual(client.ws.readyState, WebSocket.OPEN);

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("auto-rotation timer: scheduleRotation resets timer correctly", async () => {
    // Reload fresh token state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();

    // Verify that regeneration (which calls scheduleRotation) persists correct rotatedAt
    const newToken = server.regenerateToken();
    const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(persisted.token, newToken);
    assert.strictEqual(typeof persisted.rotatedAt, "number");
    assert.ok(persisted.rotatedAt > 0);

    // Verify the new token works
    const client = connectClient(port, newToken);
    await waitForOpen(client.ws);
    const snapshot = await client.waitFor("snapshot");
    assert.ok(snapshot.version);

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("atomic write: disk file contains all new fields after rotation", async () => {
    // Reload fresh token state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    // Write a fresh token file to get a clean state
    const freshToken = "deadbeef".repeat(4);
    fs.writeFileSync(tokenFile, JSON.stringify({ token: freshToken }, null, 2));
    server = initServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();
    const initialToken = server.getToken();
    assert.strictEqual(initialToken, freshToken);

    // Read initial file — should now have the new format with defaults
    const initial = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(initial.token, freshToken);
    assert.strictEqual(initial.previous, null);
    assert.strictEqual(initial.graceUntil, null);
    assert.ok(initial.rotatedAt > 0, "rotatedAt should be set to current time on creation");

    // Regenerate
    const newToken = server.regenerateToken();

    // Read after regeneration
    const after = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(after.token, newToken);
    assert.strictEqual(after.previous, null); // regenerate clears previous
    assert.strictEqual(after.graceUntil, null); // regenerate clears grace
    assert.strictEqual(typeof after.rotatedAt, "number");
    assert.ok(after.rotatedAt > 0);
    await new Promise((r) => setTimeout(r, 100));
  });

  it("Gap A: legacy file → token unchanged after startup (no immediate rotation)", async () => {
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));

    // Write a legacy M1 format file (bare { token }, no rotatedAt)
    const legacyToken = "face0ff0".repeat(4);
    fs.writeFileSync(tokenFile, JSON.stringify({ token: legacyToken }, null, 2));

    server = initServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();
    const tokenBefore = server.getToken();

    // Wait a bit — if rotatedAt were 0, scheduleRotation would fire immediately
    await new Promise((r) => setTimeout(r, 300));

    const tokenAfter = server.getToken();
    assert.strictEqual(tokenBefore, legacyToken,
      "token should be the legacy token on startup");
    assert.strictEqual(tokenAfter, legacyToken,
      "token must not change after brief wait — no immediate rotation");

    await new Promise((r) => setTimeout(r, 100));
  });

  it("Gap B: grace-period client receives token_rotate, acks, and is not kicked", async () => {
    // Set up a rotated state with an active grace window
    const oldToken = server.getToken();
    const newToken = "11223344".repeat(4);
    const state = {
      token: newToken,
      previous: oldToken,
      graceUntil: Date.now() + 5 * 60 * 1000,
      rotatedAt: Date.now(),
    };
    fs.writeFileSync(tokenFile, JSON.stringify(state, null, 2));

    // Reload server to pick up the new state
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
    server = initServer({
      sessions,
      tokenPath: tokenFile,
    });
    port = await server.start();

    // Connect with the OLD (grace-period) token
    const client = connectClient(port, oldToken);
    await waitForOpen(client.ws);

    // Should receive token_rotate with the new token
    const rotateMsg = await client.waitFor("token_rotate");
    assert.strictEqual(rotateMsg.newToken, newToken);
    assert.ok(rotateMsg.expiresAt > Date.now(), "expiresAt should be in the future");

    // Send ack back
    client.ws.send(JSON.stringify({ type: "token_rotate_ack" }));

    // Wait through a heartbeat cycle — client should NOT be kicked
    await new Promise((r) => setTimeout(r, 1500));
    assert.strictEqual(client.ws.readyState, WebSocket.OPEN,
      "client should stay connected after acking the rotation");

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });
});

// ── Rotate-on-use Tests ──

describe("Rotate-on-use", () => {
  let tmpTokenDir;
  let tokenFile;
  const sessions = new Map();

  before(async () => {
    TEST_HTTP_PORT = await getFreePort();
    tmpTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-rou-"));
    tokenFile = path.join(tmpTokenDir, "token.json");
  });

  after(() => {
    sessions.clear();
    try { fs.rmSync(tmpTokenDir, { recursive: true }); } catch {}
  });

  it("regenerateToken fails closed when token state cannot be persisted", () => {
    const testToken = "1234abcd".repeat(4);
    fs.writeFileSync(tokenFile, JSON.stringify({
      token: testToken,
      previous: null,
      graceUntil: null,
      rotatedAt: Date.now(),
      rotationPending: false,
    }, null, 2));

    const server = initServer({
      sessions,
      tokenPath: tokenFile,
      writeTokenState: () => false,
    });

    assert.strictEqual(server.getToken(), testToken);
    assert.throws(
      () => server.regenerateToken(),
      /Failed to persist mobile token state/
    );
    assert.strictEqual(server.getToken(), testToken);

    const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(persisted.token, testToken);
    assert.strictEqual(persisted.rotationPending, false);

    server.cleanup();
  });

  it("24h expiry with no clients → rotationPending persisted to disk", async () => {
    const testToken = "aabbccdd".repeat(4);
    // rotatedAt far in the past → timer fires immediately
    fs.writeFileSync(tokenFile, JSON.stringify({
      token: testToken,
      previous: null,
      graceUntil: null,
      rotatedAt: 1,
      rotationPending: false,
    }, null, 2));

    const server = initServer({ sessions, tokenPath: tokenFile });
    await server.start();
    // No clients connect — timer fires at ~0ms
    await new Promise((r) => setTimeout(r, 500));

    const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(persisted.rotationPending, true,
      "rotationPending should be true when timer fires with no clients");
    assert.strictEqual(persisted.token, testToken,
      "token should NOT have changed — no rotation happened");

    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("rotationPending=true + client connects → receives token_rotate", async () => {
    const testToken = "11223344".repeat(4);
    const setupRotatedAt = Date.now();
    fs.writeFileSync(tokenFile, JSON.stringify({
      token: testToken,
      previous: null,
      graceUntil: null,
      rotatedAt: setupRotatedAt,
      rotationPending: true,
    }, null, 2));

    const server = initServer({ sessions, tokenPath: tokenFile });
    const port = await server.start();

    const client = connectClient(port, testToken);
    await waitForOpen(client.ws);
    const rotateMsg = await client.waitFor("token_rotate");
    assert.ok(rotateMsg.newToken, "should receive new token");
    assert.notStrictEqual(rotateMsg.newToken, testToken, "new token should differ");
    assert.ok(rotateMsg.expiresAt > Date.now(), "expiresAt should be in the future");

    // rotationPending should be cleared on disk
    const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(persisted.rotationPending, false,
      "rotationPending should be false after on-connect rotation");
    assert.strictEqual(persisted.token, rotateMsg.newToken,
      "persisted token should be the new token");
    assert.ok(persisted.rotatedAt >= setupRotatedAt,
      "rotatedAt should be updated by on-connect rotation for next 24h timer");

    client.close();
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("rotationPending=true + persistence failure keeps the current token authoritative", async () => {
    const testToken = "33445566".repeat(4);
    fs.writeFileSync(tokenFile, JSON.stringify({
      token: testToken,
      previous: null,
      graceUntil: null,
      rotatedAt: Date.now(),
      rotationPending: true,
    }, null, 2));

    const server = initServer({
      sessions,
      tokenPath: tokenFile,
      writeTokenState: () => false,
    });
    const port = await server.start();

    const client = connectClient(port, testToken);
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");
    await assert.rejects(
      client.waitFor("token_rotate", 250),
      /Timeout waiting for token_rotate/
    );

    assert.strictEqual(server.getToken(), testToken);
    const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(persisted.token, testToken);
    assert.strictEqual(persisted.rotationPending, true);

    client.close();
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("rotationPending=true + regenerateToken → clears pending flag", async () => {
    const testToken = "55667788".repeat(4);
    fs.writeFileSync(tokenFile, JSON.stringify({
      token: testToken,
      previous: null,
      graceUntil: null,
      rotatedAt: Date.now(),
      rotationPending: true,
    }, null, 2));

    const server = initServer({ sessions, tokenPath: tokenFile });
    await server.start();

    const newToken = server.regenerateToken();
    assert.notStrictEqual(newToken, testToken);

    const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(persisted.rotationPending, false,
      "rotationPending should be cleared by regenerateToken");
    assert.strictEqual(persisted.token, newToken,
      "persisted token should be the regenerated token");

    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("server restart with rotationPending=true → no timer, waits for connection", async () => {
    const testToken = "99aabbcc".repeat(4);
    fs.writeFileSync(tokenFile, JSON.stringify({
      token: testToken,
      previous: null,
      graceUntil: null,
      rotatedAt: Date.now(),
      rotationPending: true,
    }, null, 2));

    const server = initServer({ sessions, tokenPath: tokenFile });
    const port = await server.start();

    // Wait — scheduleRotation should early-exit when rotationPending=true
    await new Promise((r) => setTimeout(r, 500));

    const beforeConnect = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.strictEqual(beforeConnect.token, testToken,
      "token should not change before a client connects");

    // Now connect — rotation should happen on-connect
    const client = connectClient(port, testToken);
    await waitForOpen(client.ws);
    const rotateMsg = await client.waitFor("token_rotate");
    assert.ok(rotateMsg.newToken, "should receive new token after connect");
    assert.notStrictEqual(rotateMsg.newToken, testToken);

    client.close();
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("pending rotation + multiple clients → all receive token_rotate", async () => {
    const testToken = "ddeeff00".repeat(4);
    fs.writeFileSync(tokenFile, JSON.stringify({
      token: testToken,
      previous: null,
      graceUntil: null,
      rotatedAt: Date.now(),
      rotationPending: true,
    }, null, 2));

    const server = initServer({ sessions, tokenPath: tokenFile });
    const port = await server.start();

    const client1 = connectClient(port, testToken);
    const client2 = connectClient(port, testToken);
    await waitForOpen(client1.ws);
    await waitForOpen(client2.ws);

    const rotate1 = await client1.waitFor("token_rotate");
    const rotate2 = await client2.waitFor("token_rotate");

    assert.ok(rotate1.newToken, "client1 should receive new token");
    assert.ok(rotate2.newToken, "client2 should receive new token");
    assert.strictEqual(rotate1.newToken, rotate2.newToken,
      "both clients should receive the same new token");

    client1.close();
    client2.close();
    server.cleanup();
    await new Promise((r) => setTimeout(r, 200));
  });
});

// ── v2: approvals, pairing, detail, push, public endpoints ──

function connectWithCredential(port, { token, deviceId, secret } = {}) {
  const qs = new URLSearchParams();
  if (token) qs.set("token", token);
  if (deviceId) qs.set("deviceId", deviceId);
  if (secret) qs.set("secret", secret);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${qs.toString()}`);
  const messages = [];
  const waiters = [];
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      messages.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].type === msg.type) {
          const w = waiters.splice(i, 1)[0];
          w.resolve(msg);
        }
      }
    } catch {}
  });
  return {
    ws,
    waitFor(type, timeoutMs = 5000) {
      const existing = messages.find((m) => m.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
        waiters.push({ type, resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
      });
    },
    send(obj) { ws.send(JSON.stringify(obj)); },
    close() { ws.close(); },
  };
}

// Pair a fresh token connection into a durable device credential. Returns the
// live client (whose meta now carries deviceId + approvalsAllowed) plus the
// issued { deviceId, secret } so callers can also reconnect with the secret.
async function pairDevice(server, port, token, deviceId) {
  const client = connectWithCredential(port, { token });
  await waitForOpen(client.ws);
  await client.waitFor("snapshot");
  client.send({ type: "client_hello", protocol: "v2" });
  client.send({ type: "pair", deviceId, label: "Test iPhone" });
  const paired = await client.waitFor("paired");
  return { client, deviceId: paired.deviceId, secret: paired.secret };
}

describe("Mobile Preview v2 — approvals + pairing", () => {
  let server;
  let port;
  let token;
  let tmpDir;
  let settings;
  const sessions = new Map();

  function ctxPaths(extra = {}) {
    return {
      sessions,
      getSettingsSnapshot: () => settings,
      tokenPath: path.join(tmpDir, "mobile-token.json"),
      tlsDir: path.join(tmpDir, "tls"),
      vapidPath: path.join(tmpDir, "vapid.json"),
      subsPath: path.join(tmpDir, "push-subs.json"),
      devicesPath: path.join(tmpDir, "mobile-devices.json"),
      ...extra,
    };
  }

  before(async () => {
    TEST_HTTP_PORT = await getFreePort();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-v2-"));
  });

  after(() => {
    if (server) { try { server.cleanup(); } catch {} server = null; }
    sessions.clear();
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  async function freshServer(extra = {}) {
    if (server) { server.cleanup(); await new Promise((r) => setTimeout(r, 100)); }
    sessions.clear();
    settings = { mobileApprovalsEnabled: true };
    server = initServer(ctxPaths(extra));
    port = await server.start();
    token = server.getToken();
    return server;
  }

  it("approval_decision is DROPPED when mobileApprovalsEnabled is false", async () => {
    await freshServer();
    const transport = server.getApprovalTransport();
    let fired = null;
    transport.onDecision((handle, decision) => { fired = { handle, decision }; });

    const { client } = await pairDevice(server, port, token, "device-disabled-01");

    // Register a pending approval so the handle is known to the server.
    transport.pushApproval("h-disabled", { title: "rm -rf", detail: "scary" }, "s-x");

    // Flip the global toggle OFF after pairing — the write gate must reject.
    settings.mobileApprovalsEnabled = false;

    client.send({ type: "approval_decision", handle: "h-disabled", decision: "allow" });
    await new Promise((r) => setTimeout(r, 300));

    assert.strictEqual(fired, null, "decision must be dropped when approvals are disabled");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("approval_decision is DROPPED for a non-paired (token-only) connection", async () => {
    await freshServer();
    const transport = server.getApprovalTransport();
    let fired = null;
    transport.onDecision((handle, decision) => { fired = { handle, decision }; });
    transport.pushApproval("h-token", { title: "rm -rf", detail: "scary" }, "s-y");

    // Plain token connection — never pairs, so meta.deviceId stays null → canWrite() false.
    const client = connectWithCredential(port, { token });
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");
    client.send({ type: "client_hello", protocol: "v2" });
    client.send({ type: "approval_decision", handle: "h-token", decision: "allow" });
    await new Promise((r) => setTimeout(r, 300));

    assert.strictEqual(fired, null, "token-only connection must not drive decisions");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("a paired+allowed v2 device CAN drive a decision to the decisionListener", async () => {
    await freshServer();
    const transport = server.getApprovalTransport();
    const decisions = [];
    transport.onDecision((handle, decision) => { decisions.push({ handle, decision }); });
    transport.pushApproval("h-ok", { title: "git push", detail: "to origin" }, "s-z");

    const { client } = await pairDevice(server, port, token, "device-allowed-01");
    client.send({ type: "approval_decision", handle: "h-ok", decision: "allow" });

    // Poll until the listener fires (deterministic, bounded).
    const start = Date.now();
    while (decisions.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 25));
    }

    assert.strictEqual(decisions.length, 1, "paired+allowed device must reach the listener");
    assert.strictEqual(decisions[0].handle, "h-ok");
    assert.strictEqual(decisions[0].decision, "allow");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("broadcasts a question approval with kind + questions on the wire", async () => {
    await freshServer();
    const transport = server.getApprovalTransport();
    const { client } = await pairDevice(server, port, token, "device-q-01");
    transport.pushApproval("h-q", {
      kind: "question",
      title: "claude-code asks a question",
      detail: "Pick a color",
      header: "Color",
      questions: [{ question: "Pick a color", options: [{ label: "Red" }], multiSelect: false, allowOther: true }],
    }, "s-q");
    const msg = await client.waitFor("approval_request");
    assert.strictEqual(msg.kind, "question");
    assert.strictEqual(msg.handle, "h-q");
    assert.strictEqual(msg.header, "Color");
    assert.strictEqual(msg.questions.length, 1);
    assert.strictEqual(msg.questions[0].multiSelect, false);
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("carries rich kind fields in the reconnect approval_snapshot", async () => {
    await freshServer();
    const transport = server.getApprovalTransport();
    const { client: c1, deviceId, secret } = await pairDevice(server, port, token, "device-snap-01");
    c1.close();
    await new Promise((r) => setTimeout(r, 100));
    transport.pushApproval("h-plan", { kind: "plan", title: "claude-code shared a plan", detail: "Step 1", plan: "Step 1\nStep 2" }, "s-p");

    const client = connectWithCredential(port, { deviceId, secret });
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");
    client.send({ type: "client_hello", protocol: "v2" });
    const snap = await client.waitFor("approval_snapshot");
    assert.strictEqual(snap.approvals.length, 1);
    assert.strictEqual(snap.approvals[0].kind, "plan");
    assert.strictEqual(snap.approvals[0].plan, "Step 1\nStep 2");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("DROPS a rich elicitation-submit decision from a token-only connection", async () => {
    await freshServer();
    const transport = server.getApprovalTransport();
    let fired = null;
    transport.onDecision((handle, decision) => { fired = { handle, decision }; });
    transport.pushApproval("h-rich", { kind: "question", title: "q", detail: "d", questions: [] }, "s-r");

    const client = connectWithCredential(port, { token });
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");
    client.send({ type: "client_hello", protocol: "v2" });
    client.send({ type: "approval_decision", handle: "h-rich", decision: { action: "elicitation-submit", selections: [] } });
    await new Promise((r) => setTimeout(r, 300));

    assert.strictEqual(fired, null, "unpaired connection must not drive rich decisions");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("a paired+allowed device CAN drive a rich elicitation-submit decision", async () => {
    await freshServer();
    const transport = server.getApprovalTransport();
    const decisions = [];
    transport.onDecision((handle, decision) => { decisions.push({ handle, decision }); });
    transport.pushApproval("h-rich2", { kind: "question", title: "q", detail: "d", questions: [] }, "s-r2");

    const { client } = await pairDevice(server, port, token, "device-rich-01");
    const dec = { action: "elicitation-submit", selections: [{ questionIndex: 0, optionIndices: [1] }] };
    client.send({ type: "approval_decision", handle: "h-rich2", decision: dec });

    const start = Date.now();
    while (decisions.length === 0 && Date.now() - start < 2000) { await new Promise((r) => setTimeout(r, 25)); }

    assert.strictEqual(decisions.length, 1);
    assert.deepStrictEqual(decisions[0].decision, dec);
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("request_detail returns canFocus/model/contextUsage/lastOutput when present", async () => {
    await freshServer({ focusSession: () => {} });
    sessions.set("s-detail", {
      state: "working",
      agentId: "claude-code",
      cwd: "/home/user/myproj",
      sessionTitle: "Detail Session",
      updatedAt: Date.now(),
      recentEvents: [{ kind: "tool", text: "ran ls" }],
      model: "claude-opus-4-8",
      contextUsage: { used: 1200, limit: 200000, percent: 0.6 },
      assistantLastOutput: "Here is the summary of what I did.",
    });
    server.onSnapshot();

    const client = connectWithCredential(port, { token });
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");
    client.send({ type: "request_detail", sessionId: "s-detail" });
    const detail = await client.waitFor("detail");

    assert.strictEqual(detail.sessionId, "s-detail");
    assert.ok(detail.data, "detail payload present");
    assert.strictEqual(detail.data.canFocus, true);
    assert.strictEqual(detail.data.model, "claude-opus-4-8");
    assert.strictEqual(detail.data.basename, "myproj");
    assert.deepStrictEqual(detail.data.contextUsage, { used: 1200, limit: 200000, percent: 0.6 });
    assert.strictEqual(detail.data.lastOutput, "Here is the summary of what I did.");

    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("subscribe_push requires a paired device (no deviceId -> ignored)", async () => {
    await freshServer();
    const before = server.getPushStatus().subCount;

    // Token-only connection: meta.deviceId is null, so subscribe_push must be a no-op.
    const client = connectWithCredential(port, { token });
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");
    client.send({ type: "client_hello", protocol: "v2" });
    client.send({
      type: "subscribe_push",
      subscription: { endpoint: "https://push.example/fake", keys: { p256dh: "fake", auth: "fake" } },
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(server.getPushStatus().subCount, before,
      "subscribe_push without a paired device must not register a subscription");
    client.close();

    // Paired device: the same subscribe_push DOES register.
    const { client: paired, deviceId } = await pairDevice(server, port, token, "device-push-01");
    paired.send({
      type: "subscribe_push",
      subscription: { endpoint: "https://push.example/real-fake", keys: { p256dh: "fake", auth: "fake" } },
    });
    const start = Date.now();
    while (server.getPushStatus().subCount === before && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.strictEqual(server.getPushStatus().subCount, before + 1,
      "paired device subscribe_push registers exactly one subscription");
    assert.ok(server.listDevices().some((d) => d.deviceId === deviceId));
    paired.close();
    await new Promise((r) => setTimeout(r, 100));
  });
});

describe("Mobile Preview — transcript-gated + redacted detail (Stage A)", () => {
  let server;
  let port;
  let token;
  let tmpDir;
  let settings;
  const sessions = new Map();

  function ctxPaths(extra = {}) {
    return {
      sessions,
      getSettingsSnapshot: () => settings,
      tokenPath: path.join(tmpDir, "mobile-token.json"),
      tlsDir: path.join(tmpDir, "tls"),
      vapidPath: path.join(tmpDir, "vapid.json"),
      subsPath: path.join(tmpDir, "push-subs.json"),
      devicesPath: path.join(tmpDir, "mobile-devices.json"),
      focusSession: () => {},
      ...extra,
    };
  }

  before(async () => {
    TEST_HTTP_PORT = await getFreePort();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-trx-"));
  });

  after(() => {
    if (server) { try { server.cleanup(); } catch {} server = null; }
    sessions.clear();
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  async function freshServer() {
    if (server) { server.cleanup(); await new Promise((r) => setTimeout(r, 100)); }
    sessions.clear();
    settings = { mobileApprovalsEnabled: true, mobileTranscriptEnabled: true };
    server = initServer(ctxPaths());
    port = await server.start();
    token = server.getToken();
    return server;
  }

  // Plain prose: long enough to exceed both caps, but with spaces so the secret
  // redactor's long-blob rule (40+ contiguous base64/hex chars) never fires and
  // we can assert exact post-slice lengths.
  function longText(n) {
    return "word ".repeat(Math.ceil(n / 5)).slice(0, n);
  }

  function setSession(sid, extra) {
    sessions.set(sid, {
      state: "working",
      agentId: "claude-code",
      cwd: "/home/user/proj",
      sessionTitle: "Detail",
      updatedAt: Date.now(),
      recentEvents: [],
      ...extra,
    });
    server.onSnapshot();
  }

  // Pair, grant transcriptAllowed in the registry, then reconnect with the secret
  // so the new connection captures transcriptAllowed at connect time.
  async function connectTranscriptDevice(deviceId) {
    const { client, secret } = await pairDevice(server, port, token, deviceId);
    client.close();
    await new Promise((r) => setTimeout(r, 50));
    server.setDeviceTranscriptAllowed(deviceId, true);
    const reconnected = connectWithCredential(port, { deviceId, secret });
    await waitForOpen(reconnected.ws);
    await reconnected.waitFor("snapshot");
    reconnected.send({ type: "client_hello", protocol: "v2" });
    return reconnected;
  }

  it("a transcript-allowed device gets full redacted output + currentTool/toolSummary", async () => {
    await freshServer();
    setSession("s-trx", {
      assistantLastOutput: longText(2500),
      currentTool: "Read",
      toolSummary: "src/server.js",
    });
    const client = await connectTranscriptDevice("trx-device-01");
    client.send({ type: "request_detail", sessionId: "s-trx" });
    const detail = await client.waitFor("detail");

    assert.ok(detail.data.lastOutput.length > 800, "enriched output exceeds the conservative 800 cap");
    assert.strictEqual(detail.data.lastOutput.length, 2500);
    assert.strictEqual(detail.data.currentTool, "Read");
    assert.strictEqual(detail.data.toolSummary, "src/server.js");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("a non-allowed (token-only) device gets the conservative ≤800 form with no new fields", async () => {
    await freshServer();
    setSession("s-trx2", {
      assistantLastOutput: longText(2500),
      currentTool: "Bash",
      toolSummary: "ls -la",
    });
    const client = connectWithCredential(port, { token });
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");
    client.send({ type: "request_detail", sessionId: "s-trx2" });
    const detail = await client.waitFor("detail");

    assert.strictEqual(detail.data.lastOutput.length, 800, "non-allowed output is capped at 800");
    assert.ok(!("currentTool" in detail.data), "no currentTool for non-allowed device");
    assert.ok(!("toolSummary" in detail.data), "no toolSummary for non-allowed device");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("a paired device WITHOUT transcriptAllowed stays conservative", async () => {
    await freshServer();
    setSession("s-trx3", { assistantLastOutput: longText(2500), currentTool: "Read", toolSummary: "a.js" });
    // pairDevice grants no transcript permission; the new device defaults to false.
    const { client } = await pairDevice(server, port, token, "trx-device-noperm");
    client.send({ type: "request_detail", sessionId: "s-trx3" });
    const detail = await client.waitFor("detail");
    assert.strictEqual(detail.data.lastOutput.length, 800);
    assert.ok(!("currentTool" in detail.data));
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("when mobileTranscriptEnabled is OFF, even an allowed device stays conservative", async () => {
    await freshServer();
    setSession("s-trx4", { assistantLastOutput: longText(2500), currentTool: "Read", toolSummary: "a.js" });
    const client = await connectTranscriptDevice("trx-device-off");
    settings.mobileTranscriptEnabled = false; // flip the global pref OFF after connect
    client.send({ type: "request_detail", sessionId: "s-trx4" });
    const detail = await client.waitFor("detail");
    assert.strictEqual(detail.data.lastOutput.length, 800);
    assert.ok(!("currentTool" in detail.data));
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("redacts a fake sk- token and PEM block on BOTH the enriched and conservative paths", async () => {
    await freshServer();
    const secrety = "before sk-ABCDEFGHIJKLMNOPQRSTUVWX0123 and -----BEGIN PRIVATE KEY-----\nMIIabc123\n-----END PRIVATE KEY----- after";
    setSession("s-secret", { assistantLastOutput: secrety, currentTool: "Bash", toolSummary: "echo sk-ABCDEFGHIJKLMNOPQRSTUVWX0123" });

    const allowed = await connectTranscriptDevice("trx-secret-allowed");
    allowed.send({ type: "request_detail", sessionId: "s-secret" });
    const enriched = await allowed.waitFor("detail");
    assert.ok(!/sk-ABCDEFGHIJKLMNOPQRSTUVWX0123/.test(enriched.data.lastOutput), "sk- token leaked on enriched path");
    assert.ok(!/BEGIN PRIVATE KEY/.test(enriched.data.lastOutput), "PEM leaked on enriched path");
    assert.ok(!/sk-ABCDEFGHIJKLMNOPQRSTUVWX0123/.test(enriched.data.toolSummary || ""), "sk- leaked in toolSummary");
    allowed.close();

    const tokenClient = connectWithCredential(port, { token });
    await waitForOpen(tokenClient.ws);
    await tokenClient.waitFor("snapshot");
    tokenClient.send({ type: "request_detail", sessionId: "s-secret" });
    const conservative = await tokenClient.waitFor("detail");
    assert.ok(!/sk-ABCDEFGHIJKLMNOPQRSTUVWX0123/.test(conservative.data.lastOutput), "sk- token leaked on conservative path");
    assert.ok(!/BEGIN PRIVATE KEY/.test(conservative.data.lastOutput), "PEM leaked on conservative path");
    tokenClient.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("redacts a secret that straddles the conservative 800-char cut (redact-before-slice)", async () => {
    await freshServer();
    // Position a fake sk- token so the 800-char cut would leave only a short,
    // sub-threshold prefix — which slice-then-redact would let through. Spaced
    // prose keeps the long-blob rule from firing on the filler.
    const surviving = "sk-FAKE12345";                 // 'sk-' + 9 chars, below the {16,} token threshold
    const filler = "word ".repeat((800 - surviving.length) / 5);
    const secrety = filler + surviving + "MORECHARSXYZ0123456789 done";
    setSession("s-straddle", { assistantLastOutput: secrety });

    const tokenClient = connectWithCredential(port, { token });
    await waitForOpen(tokenClient.ws);
    await tokenClient.waitFor("snapshot");
    tokenClient.send({ type: "request_detail", sessionId: "s-straddle" });
    const detail = await tokenClient.waitFor("detail");
    assert.ok(!/sk-FAKE/.test(detail.data.lastOutput), "straddling secret fragment leaked past the 800 cut");
    tokenClient.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("broadcastDetail pushes a fresh detail to a focused client after a snapshot change", async () => {
    await freshServer();
    setSession("s-live", { assistantLastOutput: "first output", currentTool: "Read", toolSummary: "a.js" });
    const client = await connectTranscriptDevice("trx-live-01");
    client.send({ type: "request_detail", sessionId: "s-live" });
    const first = await client.waitFor("detail");
    assert.strictEqual(first.data.lastOutput, "first output");

    // Mutate the session + tick — the focused client should get a PUSHED detail
    // (no new request_detail). Listen for the next "detail" frame specifically so
    // the already-buffered first one isn't what we assert on.
    const pushed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no pushed detail")), 5000);
      client.ws.on("message", (data) => {
        const m = JSON.parse(data);
        if (m.type === "detail" && m.data && m.data.lastOutput === "second output") {
          clearTimeout(timer);
          resolve(m);
        }
      });
    });
    setSession("s-live", { assistantLastOutput: "second output", currentTool: "Bash", toolSummary: "npm test" });
    const second = await pushed;
    assert.strictEqual(second.data.lastOutput, "second output");
    assert.strictEqual(second.data.toolSummary, "npm test");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("detailSid clears on close (no further detail pushes after disconnect)", async () => {
    await freshServer();
    setSession("s-close", { assistantLastOutput: "out", currentTool: "Read", toolSummary: "a.js" });
    const client = await connectTranscriptDevice("trx-close-01");
    client.send({ type: "request_detail", sessionId: "s-close" });
    await client.waitFor("detail");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
    // After close, a tick must not throw and there is no live client to push to.
    setSession("s-close", { assistantLastOutput: "changed", currentTool: "Bash", toolSummary: "x" });
    assert.doesNotThrow(() => server.onSnapshot());
  });
});

describe("Mobile Preview v2 — public HTTP endpoints", () => {
  let server;
  let port;
  let tmpDir;
  const sessions = new Map();

  before(async () => {
    TEST_HTTP_PORT = await getFreePort();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-v2-http-"));
    server = initServer({
      sessions,
      getSettingsSnapshot: () => ({ mobileApprovalsEnabled: true }),
      tokenPath: path.join(tmpDir, "mobile-token.json"),
      tlsDir: path.join(tmpDir, "tls"),
      vapidPath: path.join(tmpDir, "vapid.json"),
      subsPath: path.join(tmpDir, "push-subs.json"),
      devicesPath: path.join(tmpDir, "mobile-devices.json"),
    });
    port = await server.start();
  });

  after(() => {
    server.cleanup();
    sessions.clear();
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  it("/api/connection-info returns the documented shape", async () => {
    const res = await httpGet(port, "/api/connection-info");
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers["content-type"].includes("application/json"));
    const info = JSON.parse(res.body);
    assert.strictEqual(info.status, "ok");
    assert.strictEqual(info.port, port);
    assert.ok("httpsPort" in info);
    assert.strictEqual(info.httpsReady, false);
    assert.strictEqual(typeof info.lanIp, "string");
    assert.strictEqual(info.host, "clawd.local");
    assert.strictEqual(info.mode, "lan");
    assert.strictEqual(info.approvalsEnabled, true);
    assert.ok("pushPublicKey" in info);
    // vapid was generated (vapidPath injected) → public key is exposed here.
    assert.strictEqual(typeof info.pushPublicKey, "string");
    assert.ok(!("token" in info));
  });

  it("/api/push/vapid-public-key returns { publicKey }", async () => {
    const res = await httpGet(port, "/api/push/vapid-public-key");
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers["content-type"].includes("application/json"));
    const body = JSON.parse(res.body);
    assert.ok("publicKey" in body);
    assert.strictEqual(typeof body.publicKey, "string");
    assert.ok(body.publicKey.length > 0);
  });
});

// ── v2: typed pairing code (camera-free A2HS pairing) ──

const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function connectWithCode(port, code) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?code=${encodeURIComponent(code)}`);
  const messages = [];
  const waiters = [];
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      messages.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].type === msg.type) waiters.splice(i, 1)[0].resolve(msg);
      }
    } catch {}
  });
  return {
    ws,
    waitFor(type, timeoutMs = 5000) {
      const existing = messages.find((m) => m.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
        waiters.push({ type, resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
      });
    },
    send(obj) { ws.send(JSON.stringify(obj)); },
    close() { ws.close(); },
  };
}

describe("Mobile Preview v2 — typed pairing code", () => {
  let server;
  let port;
  let tmpDir;
  let settings;
  let clock;
  const sessions = new Map();

  function ctxPaths(extra = {}) {
    return {
      sessions,
      getSettingsSnapshot: () => settings,
      now: () => clock,
      tokenPath: path.join(tmpDir, "mobile-token.json"),
      tlsDir: path.join(tmpDir, "tls"),
      vapidPath: path.join(tmpDir, "vapid.json"),
      subsPath: path.join(tmpDir, "push-subs.json"),
      devicesPath: path.join(tmpDir, "mobile-devices.json"),
      ...extra,
    };
  }

  before(async () => {
    TEST_HTTP_PORT = await getFreePort();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-code-"));
  });

  after(() => {
    if (server) { try { server.cleanup(); } catch {} server = null; }
    sessions.clear();
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  async function freshServer(extra = {}) {
    if (server) { server.cleanup(); await new Promise((r) => setTimeout(r, 100)); }
    sessions.clear();
    clock = 1700000000000;
    settings = { mobileApprovalsEnabled: true };
    server = initServer(ctxPaths(extra));
    port = await server.start();
    return server;
  }

  it("getPairingCode returns a stable 8-char Crockford code with a future expiry", async () => {
    await freshServer();
    const a = server.getPairingCode();
    assert.strictEqual(typeof a.code, "string");
    assert.strictEqual(a.code.length, 8);
    assert.ok(/^[0-9A-HJKMNP-TV-Z]{8}$/.test(a.code), "code uses Crockford base32 (no I/L/O/U)");
    for (const ch of a.code) assert.ok(CROCKFORD32.includes(ch));
    assert.ok(a.expiresAt > clock, "expiry is in the future");
    const b = server.getPairingCode();
    assert.strictEqual(b.code, a.code, "code is stable across reads until consumed/expired");
  });

  it("accepts a WebSocket using a valid ?code= and sends a snapshot", async () => {
    await freshServer();
    const { code } = server.getPairingCode();
    const client = connectWithCode(port, code);
    await waitForOpen(client.ws);
    const snap = await client.waitFor("snapshot");
    assert.strictEqual(snap.version, "v2");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("normalizes case and separators in the submitted code", async () => {
    await freshServer();
    const { code } = server.getPairingCode();
    const messy = (code.slice(0, 4) + "-" + code.slice(4)).toLowerCase();
    const client = connectWithCode(port, messy);
    await waitForOpen(client.ws);
    const snap = await client.waitFor("snapshot");
    assert.ok(snap.version, "lowercase + dashed code is accepted");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("rejects a WebSocket using an invalid code with close 1008", async () => {
    await freshServer();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?code=ZZZZZZZ0`);
    assert.strictEqual(await waitForClose(ws), 1008);
  });

  it("rejects an expired code with close 1008", async () => {
    await freshServer();
    const { code, expiresAt } = server.getPairingCode();
    clock = expiresAt + 1;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?code=${code}`);
    assert.strictEqual(await waitForClose(ws), 1008);
  });

  it("rotates the code after 5 failed attempts (brute-force progress wiped)", async () => {
    await freshServer();
    const { code } = server.getPairingCode();
    for (let i = 0; i < 5; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?code=ZZZZZZZ${i}`);
      await waitForClose(ws);
    }
    const after = server.getPairingCode();
    assert.notStrictEqual(after.code, code, "code rotates after the attempt cap");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?code=${code}`);
    assert.strictEqual(await waitForClose(ws), 1008, "the original code no longer works");
  });

  it("issues durable creds when pairing via a code, then consumes the code (single-use)", async () => {
    await freshServer();
    const { code } = server.getPairingCode();
    const client = connectWithCode(port, code);
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");
    client.send({ type: "client_hello", protocol: "v2" });
    client.send({ type: "pair", deviceId: "code-paired-01", label: "iPhone" });
    const paired = await client.waitFor("paired");
    assert.ok(paired.deviceId && paired.secret, "pairing issues durable creds");

    const after = server.getPairingCode();
    assert.notStrictEqual(after.code, code, "a successful pair rotates the code");
    const reused = new WebSocket(`ws://127.0.0.1:${port}/ws?code=${code}`);
    assert.strictEqual(await waitForClose(reused), 1008, "the consumed code no longer authenticates");

    const durable = connectWithCredential(port, { deviceId: paired.deviceId, secret: paired.secret });
    await waitForOpen(durable.ws);
    const snap = await durable.waitFor("snapshot");
    assert.ok(snap.version, "durable creds issued via the code work on reconnect");
    client.close();
    durable.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("a code-authed connection cannot drive a decision before it pairs", async () => {
    await freshServer();
    const transport = server.getApprovalTransport();
    let fired = null;
    transport.onDecision((handle, decision) => { fired = { handle, decision }; });
    transport.pushApproval("h-code", { title: "rm -rf", detail: "scary" }, "s-c");

    const { code } = server.getPairingCode();
    const client = connectWithCode(port, code);
    await waitForOpen(client.ws);
    await client.waitFor("snapshot");
    client.send({ type: "client_hello", protocol: "v2" });
    client.send({ type: "approval_decision", handle: "h-code", decision: "allow" });
    await new Promise((r) => setTimeout(r, 300));

    assert.strictEqual(fired, null, "a code-only (unpaired) connection must not drive decisions");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("regeneratePairingCode immediately replaces the current code", async () => {
    await freshServer();
    const a = server.getPairingCode();
    const b = server.regeneratePairingCode();
    assert.notStrictEqual(b.code, a.code, "a new code is issued");
    assert.strictEqual(b.code.length, 8);
    assert.ok(b.expiresAt > clock);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?code=${a.code}`);
    assert.strictEqual(await waitForClose(ws), 1008, "the replaced code stops working");
  });
});

// ── v2: desktop language handoff (PWA defaults to the desktop's lang) ──

describe("Mobile Preview v2 — desktop language handoff", () => {
  let server;
  let port;
  let tmpDir;
  let settings;
  const sessions = new Map();

  before(async () => {
    TEST_HTTP_PORT = await getFreePort();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-lang-"));
    settings = { mobileApprovalsEnabled: true, lang: "ja" };
    server = initServer({
      sessions,
      getSettingsSnapshot: () => settings,
      tokenPath: path.join(tmpDir, "mobile-token.json"),
      tlsDir: path.join(tmpDir, "tls"),
      vapidPath: path.join(tmpDir, "vapid.json"),
      subsPath: path.join(tmpDir, "push-subs.json"),
      devicesPath: path.join(tmpDir, "mobile-devices.json"),
    });
    port = await server.start();
  });

  after(() => {
    server.cleanup();
    sessions.clear();
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  beforeEach(() => { settings = { mobileApprovalsEnabled: true, lang: "ja" }; });

  it("exposes the desktop 'lang' as desktopLanguage in /api/connection-info", async () => {
    const res = await httpGet(port, "/api/connection-info");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(JSON.parse(res.body).desktopLanguage, "ja");
  });

  it("normalizes an unsupported lang to en", async () => {
    settings.lang = "klingon";
    const res = await httpGet(port, "/api/connection-info");
    assert.strictEqual(JSON.parse(res.body).desktopLanguage, "en");
  });

  it("defaults to en when no lang is set", async () => {
    delete settings.lang;
    const res = await httpGet(port, "/api/connection-info");
    assert.strictEqual(JSON.parse(res.body).desktopLanguage, "en");
  });
});

// ── Fixed-port binding (no silent drift — the reconnect cure) ──

describe("Mobile Preview — fixed configured port", () => {
  let tmpDir;
  let servers = [];
  const sessions = new Map();

  function makeServer(settings) {
    const s = initMobilePreviewServer({
      sessions,
      getSettingsSnapshot: () => settings,
      tokenPath: path.join(tmpDir, "mobile-token.json"),
      tlsDir: path.join(tmpDir, "tls"),
      vapidPath: path.join(tmpDir, "vapid.json"),
      subsPath: path.join(tmpDir, "push-subs.json"),
      devicesPath: path.join(tmpDir, "mobile-devices.json"),
    });
    servers.push(s);
    return s;
  }

  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-port-")); });

  after(() => {
    for (const s of servers) { try { s.cleanup(); } catch {} }
    servers = [];
    sessions.clear();
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  it("binds the EXACT configured mobilePort", async () => {
    const want = await getFreePort();
    const server = makeServer({ mobilePort: want });
    const bound = await server.start();
    assert.strictEqual(bound, want, "must bind the configured port, not a drifted one");
    assert.strictEqual(server.getPort(), want);

    const res = await httpGet(want, "/api/connection-info");
    assert.strictEqual(JSON.parse(res.body).port, want);
    server.cleanup();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("an occupied configured port yields an error and does NOT drift to port+1", async () => {
    const want = await getFreePort();
    const blocker = await occupy(want);
    try {
      const server = makeServer({ mobilePort: want });
      const bound = await server.start();
      assert.strictEqual(bound, null, "start() resolves null on bind failure (no crash, no drift)");
      assert.strictEqual(server.getPort(), null, "activePort must not be a different port");
      assert.ok(server.getHttpError(), "a clear HTTP bind error is recorded");

      // The neighbouring port must NOT be in use by us (no range-walk happened).
      let neighbourFree = false;
      try {
        const probe = await occupy(want + 1);
        neighbourFree = true;
        await new Promise((r) => probe.close(r));
      } catch {}
      assert.ok(neighbourFree, "server must not have silently taken port+1");
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it("falls back to the default port when mobilePort is unset", async () => {
    // Default 23334 may be occupied in the dev env, so just assert it ATTEMPTS the
    // default (not a random drift) by checking the recorded port/error pair.
    const server = makeServer({});
    const bound = await server.start();
    if (bound !== null) {
      assert.strictEqual(bound, 23334, "unset port falls back to DEFAULT_PORT");
    } else {
      assert.ok(/23334/.test(server.getHttpError() || ""), "error names the default port");
    }
    server.cleanup();
    await new Promise((r) => setTimeout(r, 100));
  });
});

// ── Stage B: live transcript subscription over WS ──

function userLine(text, uuid) {
  return JSON.stringify({ type: "user", uuid, timestamp: "2026-06-20T00:00:00Z", message: { role: "user", content: text } }) + "\n";
}
function assistantTextLine(text, uuid) {
  return JSON.stringify({ type: "assistant", uuid, timestamp: "2026-06-20T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
}
function assistantToolLine(toolUseId, name, input, uuid) {
  return JSON.stringify({
    type: "assistant", uuid, timestamp: "2026-06-20T00:00:02Z",
    message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name, input }] },
  }) + "\n";
}
function toolResultLine(toolUseId, output, uuid) {
  return JSON.stringify({
    type: "user", uuid, timestamp: "2026-06-20T00:00:03Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: output }] },
    toolUseResult: { type: "Bash", numLines: 1 },
  }) + "\n";
}

describe("Mobile Preview — Stage B live transcript subscription", () => {
  let server;
  let port;
  let token;
  let tmpDir;
  let settings;
  const sessions = new Map();

  function ctxPaths(extra = {}) {
    return {
      sessions,
      getSettingsSnapshot: () => settings,
      tokenPath: path.join(tmpDir, "mobile-token.json"),
      tlsDir: path.join(tmpDir, "tls"),
      vapidPath: path.join(tmpDir, "vapid.json"),
      subsPath: path.join(tmpDir, "push-subs.json"),
      devicesPath: path.join(tmpDir, "mobile-devices.json"),
      ...extra,
    };
  }

  before(async () => {
    TEST_HTTP_PORT = await getFreePort();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-trx-b-"));
  });

  after(() => {
    if (server) { try { server.cleanup(); } catch {} server = null; }
    sessions.clear();
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  async function freshServer() {
    if (server) { server.cleanup(); await new Promise((r) => setTimeout(r, 100)); }
    sessions.clear();
    settings = { mobileApprovalsEnabled: true, mobileTranscriptEnabled: true, mobileTranscriptToolOutput: true };
    server = initServer(ctxPaths());
    port = await server.start();
    token = server.getToken();
    return server;
  }

  // Write a transcript file for `sid` and register the session pointing at it.
  function makeTranscript(sid, lines) {
    const file = path.join(tmpDir, `${sid}.jsonl`);
    fs.writeFileSync(file, lines.join(""));
    sessions.set(sid, {
      state: "working", agentId: "claude-code", cwd: "/home/user/proj",
      sessionTitle: "T", updatedAt: Date.now(), recentEvents: [], transcriptPath: file,
    });
    return file;
  }

  function appendTranscript(file, line) {
    fs.appendFileSync(file, line);
  }

  // Connect, pair, grant transcriptAllowed, reconnect with the secret so the new
  // meta captures transcriptAllowed at connect. Returns the live client.
  async function connectTranscriptDevice(deviceId) {
    const { client, secret } = await pairDevice(server, port, token, deviceId);
    client.close();
    await new Promise((r) => setTimeout(r, 50));
    server.setDeviceTranscriptAllowed(deviceId, true);
    const reconnected = connectWithCredential(port, { deviceId, secret });
    await waitForOpen(reconnected.ws);
    await reconnected.waitFor("snapshot");
    reconnected.send({ type: "client_hello", protocol: "v2" });
    return { client: reconnected, secret };
  }

  it("refuses subscribe with reason 'disabled' when the global transcript pref is off", async () => {
    await freshServer();
    makeTranscript("s-dis", [assistantTextLine("hi", "u1")]);
    const { client } = await connectTranscriptDevice("dev-disabled");
    settings.mobileTranscriptEnabled = false;
    client.send({ type: "subscribe_transcript", sessionId: "s-dis" });
    const msg = await client.waitFor("transcript_unavailable");
    assert.strictEqual(msg.reason, "disabled");
    client.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("refuses with 'not-allowed' for a paired device lacking transcriptAllowed", async () => {
    await freshServer();
    makeTranscript("s-na", [assistantTextLine("hi", "u1")]);
    const { client } = await pairDevice(server, port, token, "dev-notallowed"); // no transcript grant
    client.send({ type: "subscribe_transcript", sessionId: "s-na" });
    const msg = await client.waitFor("transcript_unavailable");
    assert.strictEqual(msg.reason, "not-allowed");
    client.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("refuses with 'no-path' when the session has no transcriptPath", async () => {
    await freshServer();
    sessions.set("s-nopath", { state: "working", updatedAt: Date.now(), recentEvents: [] });
    const { client } = await connectTranscriptDevice("dev-nopath");
    client.send({ type: "subscribe_transcript", sessionId: "s-nopath" });
    const msg = await client.waitFor("transcript_unavailable");
    assert.strictEqual(msg.reason, "no-path");
    client.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("an allowed device gets a snapshot, and a second client shares ONE reader (refCount 2)", async () => {
    await freshServer();
    makeTranscript("s-share", [userLine("hello", "u1"), assistantTextLine("world", "a1")]);
    const a = await connectTranscriptDevice("dev-share-a");
    a.client.send({ type: "subscribe_transcript", sessionId: "s-share" });
    const snapA = await a.client.waitFor("transcript_snapshot");
    assert.strictEqual(snapA.sessionId, "s-share");
    assert.ok(Array.isArray(snapA.entries) && snapA.entries.length >= 1);
    assert.strictEqual(snapA.toolOutput, true);

    const b = await connectTranscriptDevice("dev-share-b");
    b.client.send({ type: "subscribe_transcript", sessionId: "s-share" });
    const snapB = await b.client.waitFor("transcript_snapshot");
    assert.ok(snapB.entries.length >= 1, "second subscriber gets its own snapshot");

    assert.strictEqual(server._transcriptDebug().refCount("s-share"), 2, "reader shared, refCount is 2");
    assert.strictEqual(server._transcriptDebug().readerCount(), 1, "exactly one reader created");
    a.client.close();
    b.client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("coalesces N rapid triggers within 250ms into ONE transcript_delta", async () => {
    await freshServer();
    const file = makeTranscript("s-coal", [assistantTextLine("start", "a0")]);
    const { client } = await connectTranscriptDevice("dev-coal");
    client.send({ type: "subscribe_transcript", sessionId: "s-coal" });
    await client.waitFor("transcript_snapshot");

    const deltas = [];
    client.ws.on("message", (data) => {
      const m = JSON.parse(data);
      if (m.type === "transcript_delta") deltas.push(m);
    });

    // 3 appends + 3 ticks back-to-back, all well inside the 250ms debounce window.
    appendTranscript(file, assistantTextLine("one", "a1")); server.onSnapshot();
    appendTranscript(file, assistantTextLine("two", "a2")); server.onSnapshot();
    appendTranscript(file, assistantTextLine("three", "a3")); server.onSnapshot();

    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(deltas.length, 1, "a burst collapses into a single delta frame");
    assert.strictEqual(deltas[0].entries.length, 3, "all three new entries ride the one delta");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("re-gates per send: a device toggled off mid-session stops, an allowed one keeps receiving", async () => {
    await freshServer();
    const file = makeTranscript("s-regate", [assistantTextLine("start", "a0")]);
    const off = await connectTranscriptDevice("dev-regate-off");
    const keep = await connectTranscriptDevice("dev-regate-keep");
    off.client.send({ type: "subscribe_transcript", sessionId: "s-regate" });
    keep.client.send({ type: "subscribe_transcript", sessionId: "s-regate" });
    await off.client.waitFor("transcript_snapshot");
    await keep.client.waitFor("transcript_snapshot");

    const offDeltas = [];
    const keepDeltas = [];
    off.client.ws.on("message", (d) => { const m = JSON.parse(d); if (m.type === "transcript_delta") offDeltas.push(m); });
    keep.client.ws.on("message", (d) => { const m = JSON.parse(d); if (m.type === "transcript_delta") keepDeltas.push(m); });

    // Revoke transcript for the first device, then drive a delta.
    server.setDeviceTranscriptAllowed("dev-regate-off", false);
    appendTranscript(file, assistantTextLine("after", "a1"));
    server.onSnapshot();
    await new Promise((r) => setTimeout(r, 400));

    assert.strictEqual(offDeltas.length, 0, "revoked device receives no delta");
    assert.strictEqual(keepDeltas.length, 1, "still-allowed device keeps receiving");
    off.client.close();
    keep.client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("strips tool output + toolOutput:false when the include-tool-output pref is OFF", async () => {
    await freshServer();
    settings.mobileTranscriptToolOutput = false;
    makeTranscript("s-tool", [
      assistantToolLine("tu-1", "Bash", { command: "echo hi" }, "a1"),
      toolResultLine("tu-1", "hello output", "u2"),
    ]);
    const { client } = await connectTranscriptDevice("dev-tool-off");
    client.send({ type: "subscribe_transcript", sessionId: "s-tool" });
    const snap = await client.waitFor("transcript_snapshot");
    assert.strictEqual(snap.toolOutput, false);
    const chip = snap.entries.flatMap((e) => e.blocks).find((b) => b.kind === "tool_use");
    assert.ok(chip, "a tool chip is present");
    assert.ok(!("output" in chip), "tool output is stripped when the pref is OFF");

    // Flip ON, re-subscribe → output present + toolOutput:true. A fresh one-shot
    // listener (not waitFor, which would replay the first buffered snapshot).
    settings.mobileTranscriptToolOutput = true;
    const nextSnap = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no second snapshot")), 3000);
      client.ws.on("message", (data) => {
        const m = JSON.parse(data);
        if (m.type === "transcript_snapshot" && m.toolOutput === true) { clearTimeout(timer); resolve(m); }
      });
    });
    client.send({ type: "subscribe_transcript", sessionId: "s-tool" });
    const snap2 = await nextSnap;
    assert.strictEqual(snap2.toolOutput, true);
    const chip2 = snap2.entries.flatMap((e) => e.blocks).find((b) => b.kind === "tool_use");
    assert.ok("output" in chip2, "redacted output crosses the wire when the pref is ON");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("closeTranscriptSub: after unsubscribe the reader is closed at refCount 0 with no timer", async () => {
    await freshServer();
    const file = makeTranscript("s-teardown", [assistantTextLine("x", "a0")]);
    const { client } = await connectTranscriptDevice("dev-teardown");
    client.send({ type: "subscribe_transcript", sessionId: "s-teardown" });
    await client.waitFor("transcript_snapshot");
    assert.strictEqual(server._transcriptDebug().refCount("s-teardown"), 1);

    // Arm a debounce, then unsubscribe before it fires — the timer must be cleared.
    appendTranscript(file, assistantTextLine("y", "a1"));
    server.onSnapshot();
    client.send({ type: "unsubscribe_transcript", sessionId: "s-teardown" });
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(server._transcriptDebug().has("s-teardown"), false, "reader/entry dropped at refCount 0");
    assert.strictEqual(server._transcriptDebug().pendingTimers(), 0, "no debounce timer remains");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("closing the ws tears the sub down (no leaked reader)", async () => {
    await freshServer();
    makeTranscript("s-wsclose", [assistantTextLine("x", "a0")]);
    const { client } = await connectTranscriptDevice("dev-wsclose");
    client.send({ type: "subscribe_transcript", sessionId: "s-wsclose" });
    await client.waitFor("transcript_snapshot");
    assert.strictEqual(server._transcriptDebug().refCount("s-wsclose"), 1);
    client.close();
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(server._transcriptDebug().has("s-wsclose"), false, "ws close drops the reader");
  });

  it("session_deleted tears down the reader for all subscribers", async () => {
    await freshServer();
    makeTranscript("s-del", [assistantTextLine("x", "a0")]);
    server.onSnapshot(); // prime cache so the deletion is detected next tick
    const a = await connectTranscriptDevice("dev-del-a");
    const b = await connectTranscriptDevice("dev-del-b");
    a.client.send({ type: "subscribe_transcript", sessionId: "s-del" });
    b.client.send({ type: "subscribe_transcript", sessionId: "s-del" });
    await a.client.waitFor("transcript_snapshot");
    await b.client.waitFor("transcript_snapshot");
    assert.strictEqual(server._transcriptDebug().refCount("s-del"), 2);

    sessions.delete("s-del");
    const gone = a.client.waitFor("session_deleted");
    server.onSnapshot();
    await gone;
    assert.strictEqual(server._transcriptDebug().has("s-del"), false, "deleted session's reader is dropped");
    a.client.close();
    b.client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("request_older_transcript is EXEMPT from the 60/min close, but counted types still close 1008", async () => {
    await freshServer();
    makeTranscript("s-older", [assistantTextLine("x", "a0")]);
    const { client } = await connectTranscriptDevice("dev-older");
    client.send({ type: "subscribe_transcript", sessionId: "s-older" });
    await client.waitFor("transcript_snapshot");

    // 80 rapid request_older messages — must NOT trip the 60/min socket close.
    for (let i = 0; i < 80; i++) client.send({ type: "request_older_transcript", sessionId: "s-older", beforeCursor: "", count: 50 });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(client.ws.readyState, WebSocket.OPEN, "scrollback storm stays connected");

    // A counted type past the limit still closes with 1008.
    const counted = connectWithCredential(port, { token });
    await waitForOpen(counted.ws);
    await counted.waitFor("snapshot");
    const closed = waitForClose(counted.ws);
    for (let i = 0; i < 70; i++) counted.send({ type: "request_detail", sessionId: "nope" });
    const code = await closed;
    assert.strictEqual(code, 1008, "a counted-type flood still closes the socket");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("a path rotation (readDelta reset) re-snapshots subscribers with reset:true", async () => {
    await freshServer();
    makeTranscript("s-rot", [assistantTextLine("old", "a0")]);
    const { client } = await connectTranscriptDevice("dev-rotation");
    client.send({ type: "subscribe_transcript", sessionId: "s-rot" });
    await client.waitFor("transcript_snapshot");

    // Point the session at a brand-new transcript file → reader detects the path
    // change and returns reset:true on the next tick.
    const newFile = path.join(tmpDir, "s-rot-2.jsonl");
    fs.writeFileSync(newFile, assistantTextLine("brand new", "b0"));
    sessions.get("s-rot").transcriptPath = newFile;

    const resetSnap = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reset snapshot")), 3000);
      client.ws.on("message", (data) => {
        const m = JSON.parse(data);
        if (m.type === "transcript_snapshot" && m.reset === true) { clearTimeout(timer); resolve(m); }
      });
    });
    server.onSnapshot();
    const snap = await resetSnap;
    assert.strictEqual(snap.reset, true, "a rotation pushes a fresh snapshot with reset:true");
    assert.ok(snap.entries.some((e) => e.blocks.some((b) => b.text === "brand new")), "reset carries the new file's content");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("regenerateToken tears down active transcript subs (no leaked reader or debounce timer)", async () => {
    await freshServer();
    const file = makeTranscript("s-regen", [assistantTextLine("x", "a0")]);
    const { client } = await connectTranscriptDevice("dev-regen");
    client.send({ type: "subscribe_transcript", sessionId: "s-regen" });
    await client.waitFor("transcript_snapshot");
    assert.strictEqual(server._transcriptDebug().refCount("s-regen"), 1);

    // Arm a debounce timer, then regenerate the token (kicks all clients). ws.close
    // is async, so the synchronous clientMeta.clear() must NOT be what releases the
    // reader — regenerateToken has to tear the subs down itself.
    appendTranscript(file, assistantTextLine("y", "a1"));
    server.onSnapshot();
    assert.strictEqual(server._transcriptDebug().pendingTimers(), 1, "a debounce timer is armed before regen");

    server.regenerateToken();
    assert.strictEqual(server._transcriptDebug().readerCount(), 0, "all shared readers dropped on regen");
    assert.strictEqual(server._transcriptDebug().pendingTimers(), 0, "no debounce timer survives regen");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("an ungated client's request_older_transcript flood STILL counts toward the 60/min close", async () => {
    await freshServer();
    makeTranscript("s-ungated", [assistantTextLine("x", "a0")]);
    // A token-only monitor: never paired, no transcriptAllowed, no active sub. Its
    // request_older_transcript is not warranted, so the exemption must NOT apply.
    const mon = connectWithCredential(port, { token });
    await waitForOpen(mon.ws);
    await mon.waitFor("snapshot");
    const closed = waitForClose(mon.ws);
    for (let i = 0; i < 70; i++) mon.send({ type: "request_older_transcript", sessionId: "s-ungated", beforeCursor: "", count: 50 });
    const code = await closed;
    assert.strictEqual(code, 1008, "ungated/no-sub request_older still trips the 60/min close");
    await new Promise((r) => setTimeout(r, 100));
  });

  it("session-list payload carries hasTranscript (boolean only, never the raw path)", async () => {
    await freshServer();
    // One CC session with a transcript, one plain session without.
    makeTranscript("s-has", [assistantTextLine("x", "a0")]);
    sessions.set("s-none", { state: "idle", agentId: "telegram", cwd: "/p", sessionTitle: "T", updatedAt: Date.now(), recentEvents: [] });
    server.onSnapshot(); // prime the cache so the connect-time snapshot carries both

    const mon = connectWithCredential(port, { token });
    await waitForOpen(mon.ws);
    const snap = await mon.waitFor("snapshot");

    const withT = snap.sessions["s-has"];
    const withoutT = snap.sessions["s-none"];
    assert.strictEqual(withT.hasTranscript, true, "a CC session with a transcriptPath reports hasTranscript:true");
    assert.ok(!("transcriptPath" in withT), "the raw transcriptPath never crosses the wire");
    assert.strictEqual(withoutT.hasTranscript, false, "a session without a transcriptPath reports hasTranscript:false");
    mon.close();
    await new Promise((r) => setTimeout(r, 100));
  });
});

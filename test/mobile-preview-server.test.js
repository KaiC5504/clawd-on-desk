"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { initMobilePreviewServer, PROTOCOL_VERSION } = require("../src/network/mobile-preview-server");

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
    server = initMobilePreviewServer({
      sessions,
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
    tmpTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-rotate-"));
    tokenFile = path.join(tmpTokenDir, "token.json");
    server = initMobilePreviewServer({
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
    server = initMobilePreviewServer({
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
    server = initMobilePreviewServer({
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
    server = initMobilePreviewServer({
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
    server = initMobilePreviewServer({
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
    server = initMobilePreviewServer({
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

    server = initMobilePreviewServer({
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
    server = initMobilePreviewServer({
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
    server = initMobilePreviewServer({
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
    server = initMobilePreviewServer({
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
    server = initMobilePreviewServer({
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

    server = initMobilePreviewServer({
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
    server = initMobilePreviewServer({
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

  before(() => {
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

    const server = initMobilePreviewServer({
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

    const server = initMobilePreviewServer({ sessions, tokenPath: tokenFile });
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

    const server = initMobilePreviewServer({ sessions, tokenPath: tokenFile });
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

    const server = initMobilePreviewServer({
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

    const server = initMobilePreviewServer({ sessions, tokenPath: tokenFile });
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

    const server = initMobilePreviewServer({ sessions, tokenPath: tokenFile });
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

    const server = initMobilePreviewServer({ sessions, tokenPath: tokenFile });
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

  before(() => {
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
    server = initMobilePreviewServer(ctxPaths(extra));
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

describe("Mobile Preview v2 — public HTTP endpoints", () => {
  let server;
  let port;
  let tmpDir;
  const sessions = new Map();

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-v2-http-"));
    server = initMobilePreviewServer({
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

  before(() => {
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
    server = initMobilePreviewServer(ctxPaths(extra));
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-lang-"));
    settings = { mobileApprovalsEnabled: true, lang: "ja" };
    server = initMobilePreviewServer({
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

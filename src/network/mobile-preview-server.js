// src/network/mobile-preview-server.js — LAN bridge for PWA mobile clients
// Protocol v2 — serves static PWA files + WebSocket over plain HTTP (LAN monitor)
// and, when enabled, over HTTPS (self-signed CA) so iOS gets a secure context for
// Web Push + interactive approval. v1 read-only monitoring stays fully supported;
// v2 adds an opt-in approval channel (allow/deny/suggestion), per-device pairing,
// push, and a richer session-detail payload.
// Token rotation: 24h auto-rotation with 5-minute grace window (unchanged).

"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const WebSocket = require("ws");

const { redactSecrets } = require("../redact-secrets.js");
const { createTranscriptReader } = require("./transcript-reader");
const { ensureTls, getCaCertPem } = require("./lan-tls");
const { ensureVapid, createPushSender } = require("./web-push-keys");
const { createDeviceRegistry } = require("./mobile-device-registry");
const { createMdnsAdvertiser } = require("./mdns-advertiser");
const { SUPPORTED_LANGS } = require("../i18n");

const PROTOCOL_VERSION = "v2";
const DEFAULT_PORT = 23334;
const HTTPS_DEFAULT_PORT = 23339;
const HEARTBEAT_MS = 30000;
const CLIENT_TIMEOUT_MS = 90000;
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 60;
// Stricter ceiling for state-changing messages (approval_decision/focus_session):
// monitoring is chatty, writes shouldn't be.
const WRITE_RATE_MAX = 20;
const MAX_CLIENTS = 10;
const GRACE_PERIOD_MS = 5 * 60 * 1000;          // 5 minutes
const ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;     // a dark phone never leaks a handle
const TRANSCRIPT_DEBOUNCE_MS = 250;             // coalesce a burst of deltas into one flush
const CLAWD_HOST = "clawd.local";

// Typed pairing code: a short, human-typeable bootstrap credential for the iOS
// home-screen app (no URL token, its own empty storage). 8 chars of Crockford
// base32 ≈ 40 bits; single successful use; auto-expires; rotates after too many
// wrong guesses so brute-force progress is wiped.
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;     // 10 minutes
const PAIRING_CODE_MAX_ATTEMPTS = 5;
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // drops I/L/O/U

const PWA_DIR = path.resolve(__dirname, "../../pwa");
const CLAWD_DIR = path.join(os.homedir(), ".clawd");
const TOKEN_PATH = path.join(CLAWD_DIR, "mobile-token.json");
const TLS_DIR = path.join(CLAWD_DIR, "tls");
const VAPID_PATH = path.join(CLAWD_DIR, "vapid.json");
const PUSH_SUBS_PATH = path.join(CLAWD_DIR, "push-subs.json");
const DEVICES_PATH = path.join(CLAWD_DIR, "mobile-devices.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

// ── Token persistence ──

function atomicWrite(tokenPath, state) {
  try {
    const dir = path.dirname(tokenPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = tokenPath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmpPath, tokenPath);
    return true;
  } catch (err) {
    console.error("[mobile-preview] atomicWrite failed:", err.message);
    return false;
  }
}

function loadOrCreateTokenState(tokenPath, nowFn, writeTokenState = atomicWrite) {
  try {
    const raw = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
    if (raw && typeof raw.token === "string" && /^[a-f0-9]{32,64}$/.test(raw.token)) {
      const state = {
        token: raw.token,
        previous: raw.previous || null,
        graceUntil: typeof raw.graceUntil === "number" ? raw.graceUntil : null,
        rotatedAt: typeof raw.rotatedAt === "number" ? raw.rotatedAt : nowFn(),
        rotationPending: typeof raw.rotationPending === "boolean" ? raw.rotationPending : false,
      };
      // Backward compat: rewrite file if it was in old { token } format
      if (raw.rotatedAt === undefined) writeTokenState(tokenPath, state);
      return state;
    }
  } catch {}
  const token = crypto.randomBytes(16).toString("hex");
  const state = { token, previous: null, graceUntil: null, rotatedAt: nowFn(), rotationPending: false };
  writeTokenState(tokenPath, state);
  return state;
}

function buildMessage(type, payload) {
  return JSON.stringify({ version: PROTOCOL_VERSION, type, timestamp: Date.now(), ...payload });
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

// Push banners stay deliberately content-free: a lock-screen notification should
// say what's waiting, not dump the plan/question/command (the full thing lives in
// the app). iOS already prefixes the app name ("Clawd"), so the title carries no
// agent name either — the user knows they kicked off the work.
function buildPushNotification(payload) {
  const kind = (payload && payload.kind) || "approval";
  if (kind === "plan") return { title: "Plan ready to review", body: "Tap to open it on your phone" };
  if (kind === "question") return { title: "A question for you", body: "Tap to choose an answer" };
  return { title: "Approval needed", body: "Tap to review the request" };
}

function generatePairingCode() {
  // 256 % 32 === 0, so (byte % 32) draws each symbol from exactly 8 byte values
  // — no modulo bias.
  const bytes = crypto.randomBytes(PAIRING_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) out += CROCKFORD_ALPHABET[bytes[i] % 32];
  return out;
}

// Forgiving on input: Crockford decode aliases (O→0, I/L→1), case-insensitive,
// and any separator (dash/space) or stray char is dropped, leaving pure base32.
function normalizePairingCode(input) {
  const aliased = String(input || "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
  let out = "";
  for (const ch of aliased) if (CROCKFORD_ALPHABET.includes(ch)) out += ch;
  return out;
}

function initMobilePreviewServer(ctx) {
  const tokenPath = (ctx && ctx.tokenPath) || TOKEN_PATH;
  const now = () => (ctx && ctx.now && ctx.now()) || Date.now();
  const writeTokenState = ctx && typeof ctx.writeTokenState === "function"
    ? ctx.writeTokenState
    : atomicWrite;
  const tokenState = loadOrCreateTokenState(tokenPath, now, writeTokenState);
  const clients = new Set();
  const clientMeta = new Map();
  let sessionCache = new Map();
  let httpServer = null;
  let wss = null;
  let httpsServer = null;
  let httpsWss = null;
  let activePort = null;
  let httpsPort = null;
  let httpError = null;  // last HTTP-start failure (e.g. port bind), surfaced to Settings
  let httpsError = null; // last HTTPS-start failure, surfaced to the Settings UI
  let heartbeatTimer = null;
  let rotationTimer = null;
  let closed = false;

  // ── v2 infrastructure (TLS / push / pairing / mDNS / approvals) ──
  const tlsDir = (ctx && ctx.tlsDir) || TLS_DIR;
  const deviceRegistry = createDeviceRegistry({
    filePath: (ctx && ctx.devicesPath) || DEVICES_PATH,
    now,
  });
  let vapid = null;          // populated by ensureVapid() in start()
  let pushSender = null;
  let tlsInfo = null;        // { cert, key, ca, leafFingerprintSha256, ... } when HTTPS is up
  const mdns = createMdnsAdvertiser({ hostname: CLAWD_HOST, getIp: getLocalIP });

  // Pending approvals routed to mobile clients. handle -> { payload, sessionId, createdAt, timer }
  const approvals = new Map();
  let decisionListener = null; // set by the MobileApprovalClient via getApprovalTransport().onDecision

  // Live transcript streams, SHARED per session across every subscribed client.
  // sessionId -> { reader, refCount, debounceTimer, buffer:{entries,patches} }. One
  // reader owns the live EOF offset for a session and is fanned to all subscribers;
  // per-client subscription is the scalar meta.transcriptSub (one overlay = one
  // session). The reader is created on the first subscribe and closed only when the
  // last subscriber leaves (refCount 0).
  const transcriptSubs = new Map();

  function settingsSnapshot() {
    try { return (ctx && ctx.getSettingsSnapshot && ctx.getSettingsSnapshot()) || {}; }
    catch { return {}; }
  }
  function approvalsEnabled() { return settingsSnapshot().mobileApprovalsEnabled === true; }
  function transcriptEnabled() { return settingsSnapshot().mobileTranscriptEnabled === true; }
  function transcriptToolOutputEnabled() { return settingsSnapshot().mobileTranscriptToolOutput === true; }
  function httpsEnabled() { return settingsSnapshot().mobileHttpsEnabled === true; }
  function connectionMode() {
    const m = settingsSnapshot().mobileConnectionMode;
    return m === "tailscale" ? "tailscale" : "lan";
  }
  // The PWA defaults its language to the desktop's; only a supported code is exposed.
  function desktopLanguage() {
    const lang = settingsSnapshot().lang;
    return SUPPORTED_LANGS.includes(lang) ? lang : "en";
  }
  function isValidPort(v) { return Number.isInteger(v) && v >= 1024 && v <= 65535; }
  function configuredPort() {
    const p = settingsSnapshot().mobilePort;
    return isValidPort(p) ? p : DEFAULT_PORT;
  }
  function configuredHttpsPort() {
    const p = settingsSnapshot().mobileHttpsPort;
    return isValidPort(p) ? p : HTTPS_DEFAULT_PORT;
  }

  // ── Token rotation ──

  function persistTokenState(nextState) {
    if (!writeTokenState(tokenPath, nextState)) return false;
    Object.assign(tokenState, nextState);
    return true;
  }

  function scheduleRotationRetry() {
    if (rotationTimer) clearTimeout(rotationTimer);
    rotationTimer = setTimeout(() => {
      rotationTimer = null;
      scheduleRotation();
    }, RATE_WINDOW_MS);
  }

  function rotateToken() {
    const newToken = crypto.randomBytes(16).toString("hex");
    const rotatedAt = now();
    const nextState = {
      ...tokenState,
      previous: tokenState.token,
      token: newToken,
      graceUntil: rotatedAt + GRACE_PERIOD_MS,
      rotatedAt,
      rotationPending: false,
    };
    if (!persistTokenState(nextState)) return null;
    return newToken;
  }

  function performRotation() {
    if (!rotateToken()) {
      console.error("[mobile-preview] token rotation skipped: failed to persist token state");
      return false;
    }
    // Track which clients need to ack this rotation
    for (const meta of clientMeta.values()) {
      meta.pendingRotationAcks = (meta.pendingRotationAcks || 0) + 1;
    }
    broadcast(buildMessage("token_rotate", {
      newToken: tokenState.token,
      expiresAt: tokenState.graceUntil,
    }));
    return true;
  }

  function scheduleRotation() {
    if (tokenState.rotationPending) return;
    if (rotationTimer) clearTimeout(rotationTimer);
    const msUntilRotate = Math.max(0, (tokenState.rotatedAt + ROTATION_INTERVAL_MS) - now());
    rotationTimer = setTimeout(() => {
      rotationTimer = null;
      if (clients.size > 0) {
        if (!performRotation()) {
          scheduleRotationRetry();
          return;
        }
      } else {
        const nextState = { ...tokenState, rotationPending: true };
        if (!persistTokenState(nextState)) {
          console.error("[mobile-preview] pending token rotation skipped: failed to persist token state");
          scheduleRotationRetry();
          return;
        }
      }
      scheduleRotation(); // schedule next (if rotationPending, early-exits)
    }, msUntilRotate);
  }

  function regenerateToken() {
    const newToken = crypto.randomBytes(16).toString("hex");
    const nextState = {
      ...tokenState,
      rotationPending: false,
      previous: null,      // no grace — old token dies now
      graceUntil: null,
      token: newToken,
      rotatedAt: now(),
    };
    if (!persistTokenState(nextState)) {
      throw new Error("Failed to persist mobile token state");
    }
    // Kick all connected clients (they have stale tokens)
    for (const c of clients) {
      try { c.close(1008, "Token regenerated"); } catch {}
    }
    clients.clear();
    clientMeta.clear();
    scheduleRotation(); // reset the 24h timer
    return newToken;
  }

  // Full reset / emergency kill-switch: rotate the token, kick clients, AND wipe
  // the durable device roster + push subscriptions so every paired phone must
  // re-pair. (regenerateToken alone only rotates the token.)
  function resetMobileAccess() {
    const token = regenerateToken();
    try { deviceRegistry.revokeAll(); } catch {}
    if (pushSender) {
      try { for (const id of pushSender.listDeviceIds()) pushSender.unsubscribe(id); } catch {}
    }
    return token;
  }

  // ── Typed pairing code (ephemeral — never written to disk) ──

  let pairingCodeState = null; // { code, expiresAt, attempts }

  function freshPairingCode(nowMs) {
    pairingCodeState = {
      code: generatePairingCode(),
      expiresAt: nowMs + PAIRING_CODE_TTL_MS,
      attempts: 0,
    };
    return { code: pairingCodeState.code, expiresAt: pairingCodeState.expiresAt };
  }

  // Lazily minted on first read (the desktop must display it before anyone can
  // type it), and re-minted once it lapses so Settings always shows a live code.
  function currentPairingCode(nowMs) {
    if (!pairingCodeState || nowMs >= pairingCodeState.expiresAt) return freshPairingCode(nowMs);
    return { code: pairingCodeState.code, expiresAt: pairingCodeState.expiresAt };
  }

  function validatePairingCode(input, nowMs) {
    if (!pairingCodeState) return false;
    if (nowMs >= pairingCodeState.expiresAt) { pairingCodeState = null; return false; }
    const got = normalizePairingCode(input);
    const want = pairingCodeState.code;
    let ok = false;
    if (got.length === want.length) {
      try { ok = crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch { ok = false; }
    }
    if (!ok) {
      pairingCodeState.attempts += 1;
      if (pairingCodeState.attempts >= PAIRING_CODE_MAX_ATTEMPTS) freshPairingCode(nowMs);
      return false;
    }
    return true;
  }

  // ── HTTP server (serves PWA + WebSocket upgrade) ──

  function getLocalIP() {
    const interfaces = os.networkInterfaces();
    const wlanPattern = /WLAN|Wi-?Fi|Wireless|无线/i;
    // 1) 优先找 WLAN 接口
    for (const name of Object.keys(interfaces)) {
      if (wlanPattern.test(name)) {
        for (const iface of interfaces[name]) {
          if (iface.family === "IPv4" && !iface.internal) return iface.address;
        }
      }
    }
    // 2) fallback：第一个非 internal IPv4
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) return iface.address;
      }
    }
    return "127.0.0.1";
  }

  function serveStatic(req, res) {
    let urlPath;
    try { urlPath = new URL(req.url, "http://localhost").pathname; } catch { res.writeHead(400); res.end(); return; }

    // Connection info (no token — consumed by the PWA bootstrap + Settings QR).
    if (urlPath === "/api/connection-info") {
      const ready = Number.isInteger(activePort) && activePort > 0;
      const httpsReady = Number.isInteger(httpsPort) && httpsPort > 0;
      const info = {
        status: ready ? "ok" : (httpError ? "error" : "starting"),
        port: ready ? activePort : null,
        httpsPort: httpsReady ? httpsPort : null,
        httpsReady,
        lastError: httpError,
        lanIp: getLocalIP(),
        host: CLAWD_HOST,
        mode: connectionMode(),
        approvalsEnabled: approvalsEnabled(),
        pushPublicKey: vapid ? vapid.publicKey : null,
        desktopLanguage: desktopLanguage(),
      };
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify(info));
      return;
    }

    // CA public certificate — phone fetches over plain HTTP before trusting it.
    // Only the public cert is ever exposed; the CA private key never leaves ~/.clawd/tls.
    if (urlPath === "/ca.crt") {
      const pem = getCaCertPem({ dir: tlsDir });
      if (!pem) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        "Content-Type": "application/x-x509-ca-cert",
        "Content-Disposition": "attachment; filename=clawd-ca.crt",
        "Cache-Control": "no-cache",
      });
      res.end(pem);
      return;
    }

    // VAPID public key for Web Push subscribe (public by design).
    if (urlPath === "/api/push/vapid-public-key") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ publicKey: vapid ? vapid.publicKey : null }));
      return;
    }

    if (urlPath === "/mobile/" || urlPath === "/mobile") urlPath = "/mobile/index.html";
    if (!urlPath.startsWith("/mobile/")) { res.writeHead(404); res.end(); return; }
    const rel = urlPath.slice("/mobile/".length);
    const filePath = path.join(PWA_DIR, rel);
    if (!isPathInside(PWA_DIR, filePath)) { res.writeHead(403); res.end(); return; }
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        // sw.js must never be HTTP-cached or the browser won't notice a new
        // service worker (and the PWA stays stuck on stale code for up to an hour).
        "Cache-Control": (ext === ".html" || rel === "sw.js") ? "no-cache" : "public, max-age=3600",
      });
      res.end(data);
    });
  }

  function send(ws, type, payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(buildMessage(type, payload)); } catch {}
  }

  // Per-client ceiling for state-changing messages, separate from the chatty
  // monitoring window. Returns false when the write should be dropped.
  function withinWriteLimit(meta) {
    const nowMs = Date.now();
    if (!meta.writeWindowStart || nowMs - meta.writeWindowStart > RATE_WINDOW_MS) {
      meta.writeCount = 0;
      meta.writeWindowStart = nowMs;
    }
    return ++meta.writeCount <= WRITE_RATE_MAX;
  }

  // Shared connection handler for both the plain-HTTP and HTTPS WebSocket servers.
  function handleConnection(ws, req, secure) {
    if (closed) { ws.close(1001, "Server shutting down"); return; }

    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { ws.close(1008, "Bad request"); return; }

    // Auth, in order of precedence:
    //   1. durable per-device credential (deviceId+secret) issued at pairing time
    //   2. short-lived typed pairing code (camera-free A2HS bootstrap)
    //   3. the rotating connection token (monitoring, v1-compatible)
    const clientToken = url.searchParams.get("token");
    const deviceId = url.searchParams.get("deviceId");
    const secret = url.searchParams.get("secret");
    const pairingCodeInput = url.searchParams.get("code");
    let graceAccepted = false;
    let device = null;
    let viaPairingCode = false;

    if (deviceId && secret) {
      device = deviceRegistry.authenticate(deviceId, secret);
      if (!device) { ws.close(1008, "Invalid device credential"); return; }
    } else if (pairingCodeInput) {
      if (!validatePairingCode(pairingCodeInput, now())) { ws.close(1008, "Invalid pairing code"); return; }
      viaPairingCode = true;
    } else if (clientToken === tokenState.token) {
      // current token — ok
    } else if (tokenState.previous && clientToken === tokenState.previous
        && tokenState.graceUntil !== null && now() < tokenState.graceUntil) {
      graceAccepted = true;
    } else {
      ws.close(1008, "Invalid token");
      return;
    }

    if (clients.size >= MAX_CLIENTS) { ws.close(1013, "Server busy"); return; }

    clients.add(ws);
    const clientId = crypto.randomBytes(8).toString("hex");
    const clientIp = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    clientMeta.set(ws, {
      messageCount: 0, windowStart: Date.now(),
      writeCount: 0, writeWindowStart: Date.now(),
      clientId, ip: clientIp, lastPong: Date.now(),
      secure: !!secure,
      protocol: "v1",
      deviceId: device ? device.deviceId : null,
      approvalsAllowed: device ? device.approvalsAllowed !== false : false,
      transcriptAllowed: device ? device.transcriptAllowed === true : false,
      detailSid: null,
      transcriptSub: null,
      viaPairingCode,
    });

    // Pending rotation rotates as soon as a current-token holder appears.
    if (tokenState.rotationPending && clientToken === tokenState.token) {
      if (performRotation()) scheduleRotation();
    }

    // Session snapshot on connect (read-only monitoring — same as v1).
    try {
      const snapshot = {};
      for (const [sid, data] of sessionCache) snapshot[sid] = data;
      ws.send(buildMessage("snapshot", { sessions: snapshot }));
    } catch {}

    startHeartbeat();

    if (graceAccepted) {
      const meta = clientMeta.get(ws);
      if (meta) meta.pendingRotationAcks = 1;
      send(ws, "token_rotate", { newToken: tokenState.token, expiresAt: tokenState.graceUntil });
    }

    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
      const meta = clientMeta.get(ws);
      if (meta) meta.lastPong = Date.now();
    });

    ws.on("message", (data) => {
      if (closed) return;
      const meta = clientMeta.get(ws);
      if (!meta) return;

      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (!msg || typeof msg.type !== "string") return;

      // Parse the type FIRST so transcript scrollback can be exempted from the
      // 60/min socket-closing limit: a phone fast-paging history would otherwise
      // trip it and get disconnected. The limit stays fully intact for every
      // other type (the counter is only skipped for this one).
      if (msg.type !== "request_older_transcript") {
        const nowMs = Date.now();
        if (nowMs - meta.windowStart > RATE_WINDOW_MS) { meta.messageCount = 0; meta.windowStart = nowMs; }
        if (++meta.messageCount > RATE_MAX) { ws.close(1008, "Rate limit"); return; }
      }

      handleClientMessage(ws, meta, msg);
    });

    ws.on("close", () => {
      const meta = clientMeta.get(ws);
      if (meta) { meta.detailSid = null; closeTranscriptSub(ws, meta.transcriptSub); }
      clients.delete(ws);
      clientMeta.delete(ws);
      if (clients.size === 0) stopHeartbeat();
    });
    ws.on("error", () => {
      const meta = clientMeta.get(ws);
      if (meta) closeTranscriptSub(ws, meta.transcriptSub);
      clients.delete(ws);
      clientMeta.delete(ws);
    });
  }

  function handleClientMessage(ws, meta, msg) {
    switch (msg.type) {
      case "token_rotate_ack":
        meta.pendingRotationAcks = 0;
        return;

      // v2 handshake — only clients that announce v2 receive approval/detail traffic.
      case "client_hello": {
        meta.protocol = msg.protocol === "v2" ? "v2" : "v1";
        if (meta.protocol === "v2") sendApprovalSnapshot(ws, meta);
        return;
      }

      // Pairing: swap the one-time connection token for a durable per-device secret.
      // Only a token-authed connection (deviceId still null) may pair — a device
      // already holding a secret re-pairs over a fresh token connection.
      case "pair": {
        if (meta.deviceId !== null) {
          send(ws, "pair_error", { message: "pairing requires a fresh connection token" });
          return;
        }
        const id = String(msg.deviceId || "").trim();
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
          send(ws, "pair_error", { message: "invalid deviceId" });
          return;
        }
        let entry;
        try { entry = deviceRegistry.register({ deviceId: id, label: msg.label }); }
        catch { send(ws, "pair_error", { message: "registration failed" }); return; }
        meta.deviceId = entry.deviceId;
        meta.approvalsAllowed = entry.approvalsAllowed !== false;
        meta.transcriptAllowed = entry.transcriptAllowed === true;
        // A code is a one-time bootstrap: consume it the moment it produces a
        // durable credential so a sniffed code can't be replayed to pair again.
        if (meta.viaPairingCode) { freshPairingCode(now()); meta.viaPairingCode = false; }
        send(ws, "paired", { deviceId: entry.deviceId, secret: entry.secret, label: entry.label });
        return;
      }

      case "request_detail": {
        const sid = String(msg.sessionId || "");
        const session = ctx.sessions && ctx.sessions.get(sid);
        // Track the focused session so the snapshot tick can live-push detail
        // updates to this client (broadcastDetail). A later request_detail for a
        // different session simply replaces the tracked sid.
        meta.detailSid = sid || null;
        send(ws, "detail", { sessionId: sid, data: buildDetailPayload(sid, session, meta) });
        return;
      }

      case "subscribe_push": {
        if (!meta.deviceId || !pushSender) return;
        if (msg.subscription === null) { pushSender.unsubscribe(meta.deviceId); return; }
        if (msg.subscription && typeof msg.subscription === "object") {
          pushSender.subscribe(meta.deviceId, msg.subscription);
        }
        return;
      }

      // ── live transcript subscription (read-only; gated by canViewTranscript) ──
      case "subscribe_transcript": {
        handleSubscribeTranscript(ws, meta, String(msg.sessionId || ""));
        return;
      }

      case "unsubscribe_transcript": {
        const sid = String(msg.sessionId || "");
        if (meta.transcriptSub === sid && sid) {
          closeTranscriptSub(ws, sid);
          meta.transcriptSub = null;
        }
        return;
      }

      case "request_older_transcript": {
        const sid = String(msg.sessionId || "");
        if (!canViewTranscript(meta)) { send(ws, "transcript_unavailable", { sessionId: sid, reason: transcriptUnavailableReason(meta, sid) }); return; }
        const entry = transcriptSubs.get(sid);
        // Only a current subscriber may page (the shared reader owns the offset).
        if (!entry || meta.transcriptSub !== sid) return;
        const { entries, hasMore } = entry.reader.readOlder(msg.beforeCursor, clampOlderCount(msg.count));
        send(ws, "transcript_older", { sessionId: sid, entries: stripToolOutput(entries), hasMore });
        return;
      }

      // ── state-changing (write) messages — gated + write-rate-limited ──
      case "approval_decision": {
        if (!canWrite(meta)) return;
        if (!withinWriteLimit(meta)) { logDrop(meta, "approval_decision"); return; }
        const handle = String(msg.handle || "");
        if (!approvals.has(handle)) return; // late / duplicate / unknown — drop silently
        if (typeof decisionListener === "function") {
          try { decisionListener(handle, msg.decision); } catch {}
        }
        return;
      }

      case "focus_session": {
        if (!canWrite(meta)) return;
        if (!withinWriteLimit(meta)) { logDrop(meta, "focus_session"); return; }
        const sid = String(msg.sessionId || "");
        if (sid && ctx && typeof ctx.focusSession === "function") {
          try { ctx.focusSession(sid, { requestSource: "mobile" }); } catch {}
        }
        return;
      }

      default:
        return; // unknown types ignored (forward-compat)
    }
  }

  function isLoopbackIp(ip) {
    return ip === "127.0.0.1" || ip === "::1";
  }

  // A connection may issue writes only when: approvals are globally enabled, the
  // connection is a paired device, that device is allowed to approve, and it
  // arrived over HTTPS or loopback. The durable device secret rides in the WS
  // URL, so over plain ws on a shared LAN it is sniffable — refusing writes there
  // stops a passive eavesdropper from replaying it to approve tool runs. Plain-HTTP
  // LAN devices can still monitor; they just can't approve until HTTPS is enabled.
  function canWrite(meta) {
    if (!approvalsEnabled()) return false;
    if (!meta.deviceId || !meta.approvalsAllowed) return false;
    if (!meta.secure && !isLoopbackIp(meta.ip)) return false;
    return true;
  }

  // Gate for the enriched (longer + current-tool) detail view. Mirrors canWrite:
  // the transcript pref is on, this is a paired device explicitly allowed to view
  // transcripts, and the link is wss or loopback (the device secret rides the WS
  // URL, so on plain ws over a shared LAN it is sniffable — a non-secure remote
  // device gets only the conservative, already-redacted detail).
  function canViewTranscript(meta) {
    if (!transcriptEnabled()) return false;
    if (!meta.deviceId || !meta.transcriptAllowed) return false;
    if (!meta.secure && !isLoopbackIp(meta.ip)) return false;
    return true;
  }

  function logDrop(meta, kind) {
    console.warn(`[mobile-preview] dropped ${kind} from ${meta.ip} (write rate limit)`);
  }

  // ── live transcript subscription (Stage B) ──

  function clampOlderCount(count) {
    const n = Number(count);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 200) : 50;
  }

  // Why a connection is refused a transcript, in canViewTranscript's own order so
  // the phone shows the actionable cause (enable transcripts / grant the device /
  // use HTTPS). When the gate itself passes, the only remaining cause is a missing
  // transcriptPath.
  function transcriptUnavailableReason(meta, sessionId) {
    if (!transcriptEnabled()) return "disabled";
    if (!meta.deviceId || !meta.transcriptAllowed) return "not-allowed";
    if (!meta.secure && !isLoopbackIp(meta.ip)) return "insecure";
    return "no-path";
  }

  // Strip the (potentially large) redacted tool output off every tool_use chip
  // when the include-tool-output pref is OFF. Read the pref at SEND time so a
  // mid-session toggle takes effect on the next frame. Returns a shallow-cloned
  // entry list so the reader's own view-model is never mutated.
  function stripToolOutput(entries) {
    if (transcriptToolOutputEnabled()) return entries;
    return entries.map((entry) => {
      if (!entry || !Array.isArray(entry.blocks)) return entry;
      let touched = false;
      const blocks = entry.blocks.map((block) => {
        if (block && block.kind === "tool_use" && "output" in block) {
          touched = true;
          const { output, ...rest } = block;
          return rest;
        }
        return block;
      });
      return touched ? { ...entry, blocks } : entry;
    });
  }

  function transcriptPatchWire(sessionId, patch) {
    const wire = { sessionId, tool_use_id: patch.tool_use_id, status: patch.status, meta: patch.meta };
    if (transcriptToolOutputEnabled() && patch.output !== undefined) wire.output = patch.output;
    return wire;
  }

  // Fan one prebuilt frame out to `sessionId`'s subscribers, re-gating EACH at send
  // time: a device toggled off mid-session (canViewTranscript flips) or one that
  // switched overlays (transcriptSub changed) simply stops receiving — no separate
  // revoke push. The payload is identical across subscribers, so the strip/pref
  // read happens once at the call site (still send time).
  function sendToTranscriptSubscribers(sessionId, type, payload) {
    for (const c of clients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      const meta = clientMeta.get(c);
      if (!meta || meta.transcriptSub !== sessionId || !canViewTranscript(meta)) continue;
      send(c, type, payload);
    }
  }

  function sendTranscriptSnapshot(ws, sessionId, snap, reset) {
    const payload = {
      sessionId,
      entries: stripToolOutput(snap.entries),
      hasMore: snap.hasMore,
      toolOutput: transcriptToolOutputEnabled(),
    };
    if (reset) payload.reset = true;
    send(ws, "transcript_snapshot", payload);
  }

  function handleSubscribeTranscript(ws, meta, sessionId) {
    if (!canViewTranscript(meta)) {
      send(ws, "transcript_unavailable", { sessionId, reason: transcriptUnavailableReason(meta, sessionId) });
      return;
    }
    const session = ctx.sessions && ctx.sessions.get(sessionId);
    if (!session || !session.transcriptPath) {
      send(ws, "transcript_unavailable", { sessionId, reason: "no-path" });
      return;
    }

    // Subscribing to a new session auto-unsubscribes the previous overlay.
    if (meta.transcriptSub && meta.transcriptSub !== sessionId) {
      closeTranscriptSub(ws, meta.transcriptSub);
    }

    let entry = transcriptSubs.get(sessionId);
    if (!entry) {
      entry = {
        reader: createTranscriptReader({ path: session.transcriptPath }),
        refCount: 0,
        debounceTimer: null,
        buffer: { entries: [], patches: [] },
      };
      transcriptSubs.set(sessionId, entry);
    }
    // A re-subscribe to the same session must not double-count the refCount.
    if (meta.transcriptSub !== sessionId) entry.refCount += 1;
    meta.transcriptSub = sessionId;

    // Each subscriber gets its own snapshot off the shared reader (the reader is
    // created once; additional subscribers reuse its live offset).
    sendTranscriptSnapshot(ws, sessionId, entry.reader.snapshot(50), false);
  }

  // Single teardown path: decrement the session's refCount and, at 0, clear its
  // debounce timer + close the reader + drop the Map entry. Idempotent — a missing
  // entry or a mismatched sessionId is a no-op so every teardown site can call it
  // unconditionally.
  function closeTranscriptSub(ws, sessionId) {
    if (!sessionId) return;
    const entry = transcriptSubs.get(sessionId);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      if (entry.debounceTimer) { clearTimeout(entry.debounceTimer); entry.debounceTimer = null; }
      try { entry.reader.close(); } catch {}
      transcriptSubs.delete(sessionId);
    }
  }

  // Drain the per-session coalescing buffer to every (re-gated) subscriber: one
  // transcript_delta with the merged entries, then one transcript_result_patch per
  // buffered cross-delta patch.
  function flushTranscriptBuffer(sessionId) {
    const entry = transcriptSubs.get(sessionId);
    if (!entry) return;
    entry.debounceTimer = null;
    const { entries, patches } = entry.buffer;
    entry.buffer = { entries: [], patches: [] };
    if (entries.length === 0 && patches.length === 0) return;

    if (entries.length > 0) {
      sendToTranscriptSubscribers(sessionId, "transcript_delta", { sessionId, entries: stripToolOutput(entries) });
    }
    for (const patch of patches) {
      sendToTranscriptSubscribers(sessionId, "transcript_result_patch", transcriptPatchWire(sessionId, patch));
    }
  }

  // Per global tick: pull a delta off each live session's shared reader. A path
  // rotation/truncation (reset) re-snapshots everyone and drops buffered deltas;
  // otherwise the new entries/patches are buffered and a 250 ms debounce is armed
  // so a burst of triggers collapses into one delta frame.
  function pumpTranscripts() {
    for (const [sessionId, entry] of transcriptSubs) {
      const session = ctx.sessions && ctx.sessions.get(sessionId);
      const currentPath = session ? session.transcriptPath : null;
      const delta = entry.reader.readDelta(currentPath);
      if (delta.reset) {
        if (entry.debounceTimer) { clearTimeout(entry.debounceTimer); entry.debounceTimer = null; }
        entry.buffer = { entries: [], patches: [] };
        sendToTranscriptSubscribers(sessionId, "transcript_snapshot", {
          sessionId,
          entries: stripToolOutput(delta.entries),
          hasMore: false,
          toolOutput: transcriptToolOutputEnabled(),
          reset: true,
        });
        continue;
      }
      if (delta.entries.length === 0 && delta.patches.length === 0) continue;
      entry.buffer.entries.push(...delta.entries);
      entry.buffer.patches.push(...delta.patches);
      if (!entry.debounceTimer) {
        entry.debounceTimer = setTimeout(() => flushTranscriptBuffer(sessionId), TRANSCRIPT_DEBOUNCE_MS);
      }
    }
  }

  // ws re-emits the underlying server's 'error' (e.g. EADDRINUSE) on the
  // WebSocket.Server; swallow it here so the port-retry in listenExactPort (which
  // listens on the http server's own 'error') can do its job without crashing.
  function ignoreWssError(err) {
    if (err && err.code !== "EADDRINUSE") console.error("[mobile-preview] wss error:", err.message);
  }

  function createHttpServer() {
    httpServer = http.createServer(serveStatic);
    wss = new WebSocket.Server({ server: httpServer, path: "/ws" });
    wss.on("error", ignoreWssError);
    wss.on("connection", (ws, req) => handleConnection(ws, req, false));
  }

  function createHttpsServer() {
    if (!tlsInfo) return;
    httpsServer = https.createServer({ cert: tlsInfo.cert, key: tlsInfo.key }, serveStatic);
    httpsWss = new WebSocket.Server({ server: httpsServer, path: "/ws" });
    httpsWss.on("error", ignoreWssError);
    httpsWss.on("connection", (ws, req) => handleConnection(ws, req, true));
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      const nowMs = Date.now();
      for (const c of clients) {
        const meta = clientMeta.get(c);
        if (c.isAlive === false || (meta && nowMs - meta.lastPong > CLIENT_TIMEOUT_MS)) {
          if (meta) closeTranscriptSub(c, meta.transcriptSub);
          c.terminate();
          clients.delete(c);
          clientMeta.delete(c);
          continue;
        }
        // Retry token_rotate for unacked clients (up to 3 times)
        if (meta && meta.pendingRotationAcks > 0) {
          if (meta.pendingRotationAcks >= 3) {
            closeTranscriptSub(c, meta.transcriptSub);
            c.close(1008, "Token rotation not acknowledged");
            clients.delete(c);
            clientMeta.delete(c);
            continue;
          }
          try {
            c.send(buildMessage("token_rotate", {
              newToken: tokenState.token,
              expiresAt: tokenState.graceUntil,
            }));
          } catch {}
          meta.pendingRotationAcks++;
        }
        c.isAlive = false;
        try { c.ping(); } catch {}
      }
      if (clients.size === 0) stopHeartbeat();
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  function broadcast(message) {
    for (const c of clients) {
      if (c.readyState === WebSocket.OPEN) {
        try { c.send(message); } catch {}
      }
    }
  }

  // ── Session data ──

  function buildPayload(sid, session) {
    if (!session) return null;
    const recentEvents = Array.isArray(session.recentEvents) ? session.recentEvents.slice(-10) : [];
    return {
      sessionId: sid,
      agentId: session.agentId || null,
      title: session.sessionTitle || null,
      basename: session.cwd ? path.basename(session.cwd) : null,
      state: session.state || "idle",
      updatedAt: session.updatedAt || null,
      recentEvents,
    };
  }

  function broadcastState(sid, data) {
    broadcast(buildMessage("state", { sessionId: sid, data }));
  }

  // Superset of buildPayload for the per-session detail view. recentEvents lives
  // only on the internal session object (never in the wire snapshot), so we read
  // it straight from ctx.sessions here. No raw cwd/pid/host — only the basename.
  //
  // SECURITY INVARIANT: this is the ONLY serialization site that puts
  // assistantLastOutput / tool target on the wire to a phone (buildPayload, used
  // by the list snapshot, never carries them). So redactSecrets is applied here,
  // at the phone boundary, on every output/tool-target field. Per-client gate:
  // a canViewTranscript device gets the full redacted output (≤3000) plus the
  // current-tool fields; everyone else gets the conservative ≤800 redacted output
  // and no new fields — exactly today's behavior, just now redacted.
  function buildDetailPayload(sid, session, meta) {
    const base = buildPayload(sid, session);
    if (!base) return null;
    const out = { ...base, canFocus: typeof (ctx && ctx.focusSession) === "function" };
    if (session.model) out.model = String(session.model);
    if (session.contextUsage && typeof session.contextUsage === "object") {
      const u = session.contextUsage;
      out.contextUsage = {
        used: typeof u.used === "number" ? u.used : null,
        limit: typeof u.limit === "number" ? u.limit : undefined,
        percent: typeof u.percent === "number" ? u.percent : undefined,
      };
    }
    const enriched = !!(meta && canViewTranscript(meta));
    if (typeof session.assistantLastOutput === "string" && session.assistantLastOutput) {
      // Redact the FULL stored string before slicing — slicing first could chop a
      // secret's tail, leaving a sub-threshold prefix that escapes the redactor.
      const cap = enriched ? 3000 : 800;
      out.lastOutput = redactSecrets(session.assistantLastOutput).slice(0, cap);
    }
    if (enriched) {
      if (typeof session.currentTool === "string" && session.currentTool) {
        out.currentTool = session.currentTool;
      }
      if (typeof session.toolSummary === "string" && session.toolSummary) {
        out.toolSummary = redactSecrets(session.toolSummary);
      }
    }
    return out;
  }

  // Live-push a fresh detail payload for `sid` to every client currently focused
  // on it. Each client gets its own per-meta redaction + length gate, so a
  // transcript-allowed phone sees the enriched view and others stay conservative.
  // Driven by the snapshot tick — no separate request_detail needed per turn/tool.
  function broadcastDetail(sid) {
    if (!sid) return;
    const session = ctx.sessions && ctx.sessions.get(sid);
    for (const c of clients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      const meta = clientMeta.get(c);
      if (!meta || meta.detailSid !== sid) continue;
      send(c, "detail", { sessionId: sid, data: buildDetailPayload(sid, session, meta) });
    }
  }

  // ── Approval transport (v2) ──
  // The MobileApprovalClient adapter pushes redacted approval payloads here and
  // registers a decision listener; the seam in permission.js routes decisions
  // back to Claude Code. Payloads are ALREADY redacted by buildRemoteApprovalPayload.

  function approvalWire(payload) {
    const kind = payload.kind || "approval";
    const wire = { kind, title: payload.title, detail: payload.detail || "" };
    if (kind === "question") {
      if (payload.header) wire.header = payload.header;
      wire.questions = Array.isArray(payload.questions) ? payload.questions : [];
    } else if (kind === "plan") {
      wire.plan = payload.plan || "";
    }
    if (Array.isArray(payload.suggestions) && payload.suggestions.length) {
      wire.suggestions = payload.suggestions;
    }
    return wire;
  }

  function broadcastApproval(type, payload) {
    const msg = buildMessage(type, payload);
    for (const c of clients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      const meta = clientMeta.get(c);
      if (!meta || meta.protocol !== "v2" || !meta.approvalsAllowed) continue;
      try { c.send(msg); } catch {}
    }
  }

  function sendApprovalSnapshot(ws, meta) {
    const list = [];
    if (approvalsEnabled() && meta.approvalsAllowed) {
      for (const [handle, a] of approvals) {
        list.push({ handle, sessionId: a.sessionId, ...approvalWire(a.payload) });
      }
    }
    send(ws, "approval_snapshot", { approvals: list });
  }

  function firePush(handle, payload) {
    if (!pushSender || !pushSender.hasSub()) return;
    const note = buildPushNotification(payload);
    Promise.resolve(pushSender.send({
      title: note.title,
      body: note.body,
      handle,
      tag: `approval-${handle}`,
    })).catch(() => {});
  }

  function pushApproval(handle, payload, sessionId) {
    approvals.set(handle, { payload, sessionId: sessionId || null, createdAt: Date.now() });
    broadcastApproval("approval_request", { handle, sessionId: sessionId || null, ...approvalWire(payload) });
    firePush(handle, payload);
  }

  function neutralizeApproval(handle, outcome) {
    if (!approvals.has(handle)) return;
    approvals.delete(handle);
    broadcastApproval("approval_resolved", { handle, outcome: outcome || null });
  }

  function getApprovalTransport() {
    return {
      pushApproval,
      neutralizeApproval,
      onDecision(fn) { decisionListener = typeof fn === "function" ? fn : null; },
      isApprovalsEnabled: () => approvalsEnabled(),
      hasClients: () => {
        for (const meta of clientMeta.values()) {
          if (meta.protocol === "v2" && meta.approvalsAllowed) return true;
        }
        return false;
      },
      hasPushSub: () => !!(pushSender && pushSender.hasSub()),
    };
  }

  // ── Session polling (detects state changes + deletions) ──

  function pollSessions() {
    if (closed) return;
    const upstream = ctx.sessions;
    if (!upstream) return;

    // First poll: populate cache and broadcast snapshot to all clients
    if (sessionCache.size === 0 && upstream.size > 0) {
      for (const [sid, session] of upstream) {
        const payload = buildPayload(sid, session);
        if (payload) sessionCache.set(sid, payload);
      }
      const snapshot = {};
      for (const [sid, data] of sessionCache) snapshot[sid] = data;
      broadcast(buildMessage("snapshot", { sessions: snapshot }));
      return;
    }

    // Detect new/changed sessions
    for (const [sid, session] of upstream) {
      const payload = buildPayload(sid, session);
      if (!payload) continue;
      const cached = sessionCache.get(sid);
      if (!cached || JSON.stringify(cached) !== JSON.stringify(payload)) {
        sessionCache.set(sid, payload);
        broadcastState(sid, payload);
      }
    }

    // Detect deleted sessions
    for (const sid of sessionCache.keys()) {
      if (!upstream.has(sid)) {
        sessionCache.delete(sid);
        teardownSessionTranscript(sid);
        broadcast(buildMessage("session_deleted", { sessionId: sid }));
      }
    }
  }

  // Reflect a registry transcript-permission change onto every live connection of
  // that device, so the send-time canViewTranscript re-gate fires immediately. On
  // revoke (allowed=false) also tear down any active sub so its reader isn't leaked
  // until the socket eventually closes.
  function applyTranscriptAllowedToLiveMetas(deviceId, allowed) {
    if (!deviceId) return;
    for (const [c, meta] of clientMeta) {
      if (meta.deviceId !== deviceId) continue;
      meta.transcriptAllowed = allowed;
      if (!allowed && meta.transcriptSub) {
        closeTranscriptSub(c, meta.transcriptSub);
        meta.transcriptSub = null;
      }
    }
  }

  // Drop a whole session's transcript stream at once (its source is gone): clear
  // every subscriber's scalar sub, then force the shared entry's timer + reader to
  // close regardless of refCount.
  function teardownSessionTranscript(sessionId) {
    if (!transcriptSubs.has(sessionId)) return;
    for (const meta of clientMeta.values()) {
      if (meta.transcriptSub === sessionId) meta.transcriptSub = null;
    }
    const entry = transcriptSubs.get(sessionId);
    if (entry.debounceTimer) { clearTimeout(entry.debounceTimer); entry.debounceTimer = null; }
    try { entry.reader.close(); } catch {}
    transcriptSubs.delete(sessionId);
  }

  // ── Public API ──

  // Bind the EXACT configured port. iOS A2HS freezes its launch port, so silently
  // drifting to another port (the old range-walk) left paired phones dialing a dead
  // port forever — that was the bug. On EADDRINUSE we only retry the SAME port a few
  // times (covers our own dying instance's brief TIME_WAIT), then surface the error.
  const PORT_RETRY_ATTEMPTS = 5;
  const PORT_RETRY_DELAY_MS = 800;
  function listenExactPort(server, port, attempt = 0) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener("error", onError);
        server.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE" && attempt < PORT_RETRY_ATTEMPTS - 1) {
          setTimeout(() => {
            listenExactPort(server, port, attempt + 1).then(resolve, reject);
          }, PORT_RETRY_DELAY_MS);
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        server.removeListener("listening", onListening);
        resolve(port);
      };
      server.on("error", onError);
      server.on("listening", onListening);
      server.listen(port, "0.0.0.0");
    });
  }

  async function startHttps() {
    httpsError = null;
    let lanIp;
    try { lanIp = getLocalIP(); } catch { lanIp = null; }
    try {
      tlsInfo = await ensureTls({ dir: tlsDir, lanIp, hostnames: [CLAWD_HOST, "localhost"] });
    } catch (err) {
      console.error("[mobile-preview] TLS init failed:", err.message);
      httpsError = `Certificate setup failed: ${err.message}`;
      tlsInfo = null;
      return;
    }
    createHttpsServer();
    if (!httpsServer) { httpsError = "Could not create the HTTPS server"; return; }
    const wantPort = configuredHttpsPort();
    try {
      httpsPort = await listenExactPort(httpsServer, wantPort);
      console.log(`[mobile-preview] HTTPS on 0.0.0.0:${httpsPort}`);
      // clawd.local matters once we hand out https://clawd.local:<port> URLs.
      try { mdns.start(); } catch {}
    } catch (err) {
      console.error("[mobile-preview] HTTPS listen failed:", err.message);
      httpsError = err.code === "EADDRINUSE"
        ? `HTTPS port ${wantPort} is already in use. Pick a different HTTPS port.`
        : `HTTPS could not start: ${err.message}`;
      try { httpsServer.close(); } catch {}
      httpsServer = null;
      if (httpsWss) { try { httpsWss.close(); } catch {} httpsWss = null; }
      httpsPort = null;
    }
  }

  function stopHttps() {
    httpsError = null;
    try { mdns.stop(); } catch {}
    if (httpsWss) { try { httpsWss.close(); } catch {} httpsWss = null; }
    if (httpsServer) { try { httpsServer.close(); } catch {} httpsServer = null; }
    httpsPort = null;
  }

  // VAPID/push keys are only generated once approvals or HTTPS are in play (or a
  // test injects an explicit path). This keeps pure read-only monitoring from
  // writing key material under ~/.clawd.
  async function ensurePushKeysIfNeeded() {
    if (vapid) return;
    const wanted = approvalsEnabled() || httpsEnabled() || (ctx && ctx.vapidPath);
    if (!wanted) return;
    try {
      vapid = await ensureVapid({ filePath: (ctx && ctx.vapidPath) || VAPID_PATH });
      pushSender = createPushSender({ vapid, subsPath: (ctx && ctx.subsPath) || PUSH_SUBS_PATH });
    } catch (err) {
      console.error("[mobile-preview] VAPID init failed:", err.message);
    }
  }

  // Reconcile push keys + the HTTPS listener with current prefs at runtime. The
  // Settings toggles (mobileHttpsEnabled / mobileApprovalsEnabled) call this so
  // the whole server doesn't have to restart.
  async function reconcile() {
    if (closed) return;
    await ensurePushKeysIfNeeded();
    if (httpsEnabled() && !httpsServer) await startHttps();
    else if (!httpsEnabled() && httpsServer) stopHttps();
  }

  async function start() {
    closed = false;
    httpError = null;

    createHttpServer();
    const wantPort = configuredPort();
    try {
      activePort = await listenExactPort(httpServer, wantPort);
      console.log(`[mobile-preview] started on 0.0.0.0:${activePort}`);
    } catch (err) {
      // A bind failure must not take the whole app down — surface it to Settings.
      // HTTPS is bound independently below, so an occupied HTTP port still leaves a
      // secure-context (wss) phone working.
      console.error("[mobile-preview] HTTP listen failed:", err.message);
      httpError = err.code === "EADDRINUSE"
        ? `Port ${wantPort} is already in use. Pick a different port.`
        : `Mobile bridge could not start: ${err.message}`;
      try { httpServer.close(); } catch {}
      httpServer = null;
      if (wss) { try { wss.close(); } catch {} wss = null; }
      activePort = null;
    }

    await ensurePushKeysIfNeeded();
    if (httpsEnabled()) await startHttps();

    // Skip polling/rotation only when neither listener came up.
    if (activePort || httpsPort) {
      pollSessions(); // Prime cache from current state
      scheduleRotation(); // Start the 24h rotation timer
    }
    return activePort;
  }

  function cleanup() {
    closed = true;
    sessionCache.clear();
    stopHeartbeat();
    if (rotationTimer) { clearTimeout(rotationTimer); rotationTimer = null; }
    for (const c of clients) { try { c.close(1001, "Server shutting down"); } catch {} }
    clients.clear();
    clientMeta.clear();
    approvals.clear();
    // Drop every shared reader + its debounce timer (the per-client subs went with
    // clientMeta.clear() above; this releases the server-owned side).
    for (const entry of transcriptSubs.values()) {
      if (entry.debounceTimer) { clearTimeout(entry.debounceTimer); entry.debounceTimer = null; }
      try { entry.reader.close(); } catch {}
    }
    transcriptSubs.clear();
    decisionListener = null;
    try { mdns.stop(); } catch {}
    stopHttps();
    if (wss) { try { wss.close(); } catch {} wss = null; }
    if (httpServer) { try { httpServer.close(); } catch {} httpServer = null; }
  }

  function onSnapshot() {
    if (closed) return;
    pollSessions();
    // Live-update each focused detail screen on the same coarse tick the list
    // snapshot rides — so the detail view follows turn/tool boundaries without a
    // fresh request_detail. Dedupe the focused sids; each client is gated per-meta.
    const focused = new Set();
    for (const meta of clientMeta.values()) {
      if (meta.detailSid) focused.add(meta.detailSid);
    }
    for (const sid of focused) broadcastDetail(sid);
    // Live transcript deltas ride the same coarse tick; coalesced per session.
    pumpTranscripts();
  }

  function getHttpsInfo() {
    return {
      httpsReady: Number.isInteger(httpsPort) && httpsPort > 0,
      httpsPort: httpsPort || null,
      host: CLAWD_HOST,
      lanIp: getLocalIP(),
      mode: connectionMode(),
      caFingerprint: tlsInfo ? tlsInfo.ca.fingerprintSha256 : null,
      leafFingerprint: tlsInfo ? tlsInfo.leafFingerprintSha256 : null,
      caExists: !!getCaCertPem({ dir: tlsDir }),
      lastError: httpsError,
    };
  }

  function getPushStatus() {
    return {
      hasVapid: !!vapid,
      publicKey: vapid ? vapid.publicKey : null,
      subCount: pushSender ? pushSender.listDeviceIds().length : 0,
    };
  }

  return {
    start,
    cleanup,
    onSnapshot,
    reconcile,
    getPort: () => activePort,
    getHttpsPort: () => httpsPort,
    getHttpError: () => httpError,
    getToken: () => tokenState.token,
    getPairingCode: () => currentPairingCode(now()),
    regeneratePairingCode: () => freshPairingCode(now()),
    regenerateToken,
    resetMobileAccess,
    getApprovalTransport,
    getHttpsInfo,
    getPushStatus,
    listDevices: () => deviceRegistry.list(),
    revokeDevice: (id) => {
      const r = deviceRegistry.revoke(id);
      if (pushSender) pushSender.unsubscribe(id);
      applyTranscriptAllowedToLiveMetas(id, false);
      return r;
    },
    setDeviceApprovalsAllowed: (id, allowed) => deviceRegistry.setApprovalsAllowed(id, allowed),
    setDeviceTranscriptAllowed: (id, allowed) => {
      const r = deviceRegistry.setTranscriptAllowed(id, allowed);
      applyTranscriptAllowedToLiveMetas(id, !!allowed);
      return r;
    },
    getLocalIP,
    PROTOCOL_VERSION,
    // Test-only inspection of the shared transcript-reader lifecycle.
    _transcriptDebug: () => ({
      refCount: (sid) => { const e = transcriptSubs.get(sid); return e ? e.refCount : 0; },
      has: (sid) => transcriptSubs.has(sid),
      readerCount: () => transcriptSubs.size,
      pendingTimers: () => {
        let n = 0;
        for (const e of transcriptSubs.values()) if (e.debounceTimer) n += 1;
        return n;
      },
    }),
  };
}

module.exports = { initMobilePreviewServer, PROTOCOL_VERSION, buildPushNotification };

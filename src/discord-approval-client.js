"use strict";

// Third remote-approval adapter (alongside the desktop bubble and Telegram).
// Implements the seam contract: isEnabled() + requestApproval(payload, {signal})
// -> Promise<"allow"|"deny"|{action:"suggestion",index}|null>. Transport is a
// Discord BOT: an outbound Gateway WebSocket (button clicks arrive as
// INTERACTION_CREATE) plus outbound REST callbacks/edits. No public URL, no
// inbound port. Zero new deps: raw `ws` (already a dep) + raw `https`.
//
// Security invariants (mirror the Telegram adapter):
// - Owner-gated: a click is honored only if the clicking user id == ownerUserId.
// - Opaque custom_id: `approve:{handle}` / `deny:{handle}` — never a command,
//   path, or session id. Payload text is pre-redacted upstream.
// - Fail-safe: any send/transport failure resolves null and leaves the local
//   bubble/terminal in charge. NEVER auto-approves on error.

const DISCORD_API_HOST = "discord.com";
const DISCORD_API_VERSION = "v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
// "Cannot send messages to this user" — owner has DMs closed; fall back to the
// configured private channel.
const ERR_CANNOT_DM = 50007;

// Discord interaction callback types.
const CALLBACK_DEFERRED_UPDATE = 6; // ACK a component interaction, edit later
// Discord button styles.
const BTN_SUCCESS = 3;
const BTN_DANGER = 4;
const BTN_SECONDARY = 2;

function parseCustomId(id) {
  let m = /^(approve|deny):(.+)$/.exec(id);
  if (m) return { action: m[1] === "approve" ? "allow" : "deny", handle: m[2] };
  m = /^sug:([^:]+):(\d+)$/.exec(id);
  if (m) return { action: "suggestion", handle: m[1], index: Number(m[2]) };
  return null;
}

function buildComponents(handle, payload) {
  const rows = [{
    type: 1,
    components: [
      { type: 2, style: BTN_SUCCESS, label: "Allow", custom_id: `approve:${handle}` },
      { type: 2, style: BTN_DANGER, label: "Deny", custom_id: `deny:${handle}` },
    ],
  }];
  const suggestions = Array.isArray(payload.suggestions) ? payload.suggestions.slice(0, 5) : [];
  if (suggestions.length) {
    rows.push({
      type: 1,
      components: suggestions.map((s) => ({
        type: 2,
        style: BTN_SECONDARY,
        label: String(s.label || "Option").slice(0, 80),
        custom_id: `sug:${handle}:${Number(s.index) || 0}`,
      })),
    });
  }
  return rows;
}

function buildCardBody(handle, payload) {
  return {
    embeds: [{
      title: String(payload.title || "Approval request").slice(0, 256),
      description: String(payload.detail || "").slice(0, 4096),
    }],
    components: buildComponents(handle, payload),
  };
}

function buildNeutralizedBody(payload, outcomeLine) {
  const base = String(payload.detail || "");
  const description = `${base}\n\n${outcomeLine}`.slice(0, 4096);
  return {
    embeds: [{ title: String(payload.title || "Approval request").slice(0, 256), description }],
    components: [],
  };
}

function outcomeText(kind) {
  if (kind === "allow") return "✅ Approved via Discord";
  if (kind === "deny") return "⛔ Denied via Discord";
  if (kind === "suggestion") return "✅ Approved with an option via Discord";
  return "↩︎ Resolved on another surface";
}

// Raw-https REST client. Each method resolves with parsed JSON (or null) on 2xx
// and rejects with an Error carrying `.status` and Discord `.code` otherwise.
function createDiscordRestClient({ token, https = require("https"), log = () => {} } = {}) {
  function request(method, route, body) {
    return new Promise((resolve, reject) => {
      const data = body != null ? JSON.stringify(body) : null;
      const headers = {
        "Authorization": `Bot ${token}`,
        "User-Agent": "DiscordBot (https://github.com/rullerzhou-afk/clawd-on-desk, 1.0)",
      };
      if (data) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(data);
      }
      let req;
      try {
        req = https.request({
          hostname: DISCORD_API_HOST,
          path: `/api/${DISCORD_API_VERSION}${route}`,
          method,
          headers,
        }, (res) => {
          let chunks = "";
          res.setEncoding("utf8");
          res.on("data", (c) => { chunks += c; });
          res.on("end", () => {
            let parsed = null;
            try { parsed = chunks ? JSON.parse(chunks) : null; } catch {}
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
              return;
            }
            const err = new Error(`Discord REST ${method} ${route} -> ${res.statusCode}`);
            err.status = res.statusCode;
            err.code = parsed && parsed.code;
            err.retryAfter = parsed && parsed.retry_after;
            reject(err);
          });
        });
      } catch (err) {
        reject(err);
        return;
      }
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  return {
    createDMChannel(recipientId) {
      return request("POST", "/users/@me/channels", { recipient_id: String(recipientId) });
    },
    createMessage(channelId, body) {
      return request("POST", `/channels/${channelId}/messages`, body);
    },
    editMessage(channelId, messageId, body) {
      return request("PATCH", `/channels/${channelId}/messages/${messageId}`, body);
    },
    interactionCallback(interactionId, interactionToken, payload) {
      return request("POST", `/interactions/${interactionId}/${interactionToken}/callback`, payload);
    },
  };
}

// Raw-ws Gateway connection. Handles identify/heartbeat/RESUME with backoff and
// delivers INTERACTION_CREATE payloads to the registered handler. It never
// tight-loops on an auth failure (close 4004) — that would trip Discord's
// invalid-request ban.
function createDiscordGateway({ token, log = () => {}, WebSocketImpl } = {}) {
  const WS = WebSocketImpl || require("ws");
  let ws = null;
  let heartbeatTimer = null;
  let seq = null;
  let sessionId = null;
  let resumeUrl = null;
  let interactionHandler = null;
  let closedByUs = false;
  let acked = true;
  let backoffMs = 1000;

  function send(op, d) {
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ op, d })); } catch {}
  }
  function identify() {
    send(2, {
      token,
      intents: 0, // interactions are delivered regardless of intents
      properties: { os: process.platform, browser: "clawd-on-desk", device: "clawd-on-desk" },
    });
  }
  function resume() {
    send(6, { token, session_id: sessionId, seq });
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }
  function startHeartbeat(intervalMs) {
    stopHeartbeat();
    acked = true;
    heartbeatTimer = setInterval(() => {
      if (!acked) { try { ws.close(4000); } catch {} return; }
      acked = false;
      send(1, seq);
    }, intervalMs);
  }
  function open() {
    if (closedByUs) return;
    const url = resumeUrl ? `${resumeUrl}/?v=${DISCORD_API_VERSION.slice(1)}&encoding=json` : GATEWAY_URL;
    try { ws = new WS(url); } catch (err) { log("warn", `gateway open failed: ${err && err.message}`); scheduleReconnect(); return; }
    ws.on("open", () => { backoffMs = 1000; });
    ws.on("message", (raw) => {
      let payload;
      try { payload = JSON.parse(raw.toString()); } catch { return; }
      const { op, d, s, t } = payload;
      if (s != null) seq = s;
      if (op === 10) {
        startHeartbeat(d.heartbeat_interval);
        if (sessionId && resumeUrl) resume(); else identify();
      } else if (op === 11) {
        acked = true;
      } else if (op === 1) {
        send(1, seq);
      } else if (op === 7) {
        try { ws.close(4901); } catch {}
      } else if (op === 9) {
        sessionId = null; resumeUrl = null;
        try { ws.close(4900); } catch {}
      } else if (op === 0) {
        if (t === "READY") { sessionId = d.session_id; resumeUrl = d.resume_gateway_url; }
        else if (t === "RESUMED") { /* nothing to do */ }
        else if (t === "INTERACTION_CREATE" && interactionHandler) {
          try { interactionHandler(d); } catch (err) { log("error", `interaction handler: ${err && err.message}`); }
        }
      }
    });
    ws.on("close", (code) => {
      stopHeartbeat();
      if (closedByUs) return;
      if (code === 4004) { log("error", "gateway auth failed (4004) — not reconnecting; re-check the bot token"); return; }
      // Sessions can't be resumed after these — re-identify fresh.
      if (code === 4007 || code === 4009) { sessionId = null; resumeUrl = null; }
      scheduleReconnect();
    });
    ws.on("error", (err) => { log("warn", `gateway error: ${err && err.message}`); });
  }
  function scheduleReconnect() {
    if (closedByUs) return;
    const delay = Math.min(backoffMs, 30000);
    backoffMs = Math.min(backoffMs * 2, 30000);
    setTimeout(open, delay);
  }

  return {
    onInteraction(fn) { interactionHandler = fn; },
    connect() { closedByUs = false; open(); },
    close() {
      closedByUs = true;
      stopHeartbeat();
      if (ws) { try { ws.close(1000); } catch {} ws = null; }
    },
  };
}

class DiscordApprovalClient {
  constructor({ token, ownerUserId, fallbackChannelId, rest, gateway, log } = {}) {
    this.token = token || "";
    this.ownerUserId = String(ownerUserId || "");
    this.fallbackChannelId = String(fallbackChannelId || "");
    this._log = typeof log === "function" ? log : () => {};
    this.rest = rest || createDiscordRestClient({ token: this.token, log: this._log });
    this.gateway = gateway || createDiscordGateway({ token: this.token, log: this._log });
    this._pending = new Map();
    this._started = false;
    this._handleSeq = 0;
  }

  isEnabled() {
    return !!(this.token && this.ownerUserId);
  }

  start() {
    if (this._started) return;
    this._started = true;
    if (this.gateway && typeof this.gateway.onInteraction === "function") {
      this.gateway.onInteraction((interaction) => this._handleInteraction(interaction));
    }
    if (this.gateway && typeof this.gateway.connect === "function") this.gateway.connect();
  }

  stop() {
    this._started = false;
    if (this.gateway && typeof this.gateway.close === "function") {
      try { this.gateway.close(); } catch {}
    }
    for (const pending of [...this._pending.values()]) {
      try { pending.finish(null); } catch {}
    }
    this._pending.clear();
  }

  _mintHandle() {
    this._handleSeq += 1;
    return `${this._handleSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  requestApproval(payload, options = {}) {
    const signal = options.signal;
    if (signal && signal.aborted) return Promise.resolve(null);
    if (!payload || !payload.title) return Promise.resolve(null);

    const handle = this._mintHandle();
    return new Promise((resolve) => {
      let settled = false;
      const pending = {
        handle,
        payload,
        messageRef: null,
        aborted: false,
        neutralized: false,
        finish: null,
      };
      const finish = (decision) => {
        if (settled) return;
        settled = true;
        if (signal) { try { signal.removeEventListener("abort", onAbort); } catch {} }
        this._pending.delete(handle);
        if (decision === "allow" || decision === "deny") resolve(decision);
        else if (decision && decision.action === "suggestion") resolve(decision);
        else resolve(null);
      };
      const onAbort = () => {
        pending.aborted = true;
        this._neutralize(pending, outcomeText("aborted"));
        finish(null);
      };
      pending.finish = finish;
      if (signal) { try { signal.addEventListener("abort", onAbort, { once: true }); } catch {} }
      this._pending.set(handle, pending);

      this._postCard(pending).then((ref) => {
        if (!ref) { finish(null); return; } // send failed -> fail-safe
        pending.messageRef = ref;
        if (pending.aborted) this._neutralize(pending, outcomeText("aborted"));
      }).catch((err) => {
        this._log("warn", `discord approval post failed: ${err && err.message}`);
        finish(null);
      });
    });
  }

  async _postCard(pending) {
    const body = buildCardBody(pending.handle, pending.payload);
    try {
      const dm = await this.rest.createDMChannel(this.ownerUserId);
      const channelId = dm && dm.id;
      const msg = await this.rest.createMessage(channelId, body);
      return { channelId, messageId: msg && msg.id };
    } catch (err) {
      if (err && Number(err.code) === ERR_CANNOT_DM && this.fallbackChannelId) {
        try {
          const msg = await this.rest.createMessage(this.fallbackChannelId, body);
          return { channelId: this.fallbackChannelId, messageId: msg && msg.id };
        } catch (err2) {
          this._log("warn", `discord fallback channel send failed: ${err2 && err2.message}`);
          return null;
        }
      }
      this._log("warn", `discord DM send failed (code=${err && err.code}): ${err && err.message}`);
      return null;
    }
  }

  _handleInteraction(interaction) {
    if (!interaction || interaction.type !== 3) return; // MESSAGE_COMPONENT only
    const data = interaction.data || {};
    const parsed = parseCustomId(String(data.custom_id || ""));
    if (!parsed) return;
    const pending = this._pending.get(parsed.handle);
    if (!pending) return;
    const clickerId = (interaction.member && interaction.member.user && interaction.member.user.id)
      || (interaction.user && interaction.user.id) || null;
    if (!clickerId || String(clickerId) !== this.ownerUserId) {
      this._log("warn", "ignoring discord interaction from a non-owner user");
      return;
    }
    // ACK within Discord's 3s deadline with a deferred update; the actual card
    // rewrite (neutralization) happens as a best-effort message edit afterwards.
    Promise.resolve(this.rest.interactionCallback(interaction.id, interaction.token, { type: CALLBACK_DEFERRED_UPDATE }))
      .catch((err) => this._log("warn", `discord interaction ack failed: ${err && err.message}`));

    this._neutralize(pending, outcomeText(parsed.action));
    if (parsed.action === "suggestion") pending.finish({ action: "suggestion", index: parsed.index });
    else pending.finish(parsed.action);
  }

  _neutralize(pending, outcomeLine) {
    if (!pending || pending.neutralized) return;
    const ref = pending.messageRef;
    if (!ref || !ref.channelId || !ref.messageId) return; // not posted yet
    pending.neutralized = true;
    const body = buildNeutralizedBody(pending.payload, outcomeLine);
    Promise.resolve(this.rest.editMessage(ref.channelId, ref.messageId, body))
      .catch((err) => this._log("debug", `discord card neutralize failed: ${err && err.message}`));
  }
}

module.exports = {
  DiscordApprovalClient,
  createDiscordRestClient,
  createDiscordGateway,
  parseCustomId,
  buildComponents,
  buildCardBody,
  buildNeutralizedBody,
};

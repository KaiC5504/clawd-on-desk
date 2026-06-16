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
const CALLBACK_DEFERRED_UPDATE = 6; // ACK a component interaction, no visible change
const CALLBACK_UPDATE_MESSAGE = 7;  // ACK + rewrite the source message in one go
const CALLBACK_MODAL = 9;           // open a text-input modal
// Discord component types + button/text-input styles.
const COMP_ACTION_ROW = 1;
const COMP_BUTTON = 2;
const COMP_STRING_SELECT = 3;
const COMP_TEXT_INPUT = 4;
const BTN_PRIMARY = 1;
const BTN_SECONDARY = 2;
const BTN_SUCCESS = 3;
const BTN_DANGER = 4;
const TEXT_INPUT_SHORT = 1;
const TEXT_INPUT_PARAGRAPH = 2;

function clip(value, max) {
  return String(value == null ? "" : value).slice(0, max);
}

function parseCustomId(id) {
  let m;
  if ((m = /^approve:(.+)$/.exec(id))) return { type: "approve", handle: m[1] };
  if ((m = /^deny:(.+)$/.exec(id))) return { type: "deny", handle: m[1] };
  if ((m = /^sug:([^:]+):(\d+)$/.exec(id))) return { type: "suggestion", handle: m[1], index: Number(m[2]) };
  if ((m = /^planmod:(.+)$/.exec(id))) return { type: "planmod", handle: m[1] };
  if ((m = /^planmodal:(.+)$/.exec(id))) return { type: "planmodal", handle: m[1] };
  if ((m = /^qopt:([^:]+):(\d+):(\d+)$/.exec(id))) return { type: "qopt", handle: m[1], q: Number(m[2]), o: Number(m[3]) };
  if ((m = /^qsel:([^:]+):(\d+)$/.exec(id))) return { type: "qsel", handle: m[1], q: Number(m[2]) };
  if ((m = /^qok:([^:]+):(\d+)$/.exec(id))) return { type: "qok", handle: m[1], q: Number(m[2]) };
  if ((m = /^qother:([^:]+):(\d+)$/.exec(id))) return { type: "qother", handle: m[1], q: Number(m[2]) };
  if ((m = /^qothermodal:([^:]+):(\d+)$/.exec(id))) return { type: "qothermodal", handle: m[1], q: Number(m[2]) };
  return null;
}

// Default "approval" kind: Allow / Deny + optional rich-suggestion buttons.
function buildApprovalComponents(handle, payload) {
  const rows = [{
    type: COMP_ACTION_ROW,
    components: [
      { type: COMP_BUTTON, style: BTN_SUCCESS, label: "Allow", custom_id: `approve:${handle}` },
      { type: COMP_BUTTON, style: BTN_DANGER, label: "Deny", custom_id: `deny:${handle}` },
    ],
  }];
  const suggestions = Array.isArray(payload.suggestions) ? payload.suggestions.slice(0, 5) : [];
  if (suggestions.length) {
    rows.push({
      type: COMP_ACTION_ROW,
      components: suggestions.map((s) => ({
        type: COMP_BUTTON, style: BTN_SECONDARY,
        label: clip(s.label || "Option", 80),
        custom_id: `sug:${handle}:${Number(s.index) || 0}`,
      })),
    });
  }
  return rows;
}

// Back-compat alias (kept for callers/tests that build the plain approval card).
function buildComponents(handle, payload) {
  return buildApprovalComponents(handle, payload);
}

// "plan" kind: Approve / Keep planning / Request changes (opens a feedback modal).
function buildPlanComponents(handle) {
  return [{
    type: COMP_ACTION_ROW,
    components: [
      { type: COMP_BUTTON, style: BTN_SUCCESS, label: "Approve", custom_id: `approve:${handle}` },
      { type: COMP_BUTTON, style: BTN_SECONDARY, label: "Keep planning", custom_id: `deny:${handle}` },
      { type: COMP_BUTTON, style: BTN_PRIMARY, label: "Request changes", custom_id: `planmod:${handle}` },
    ],
  }];
}

// "question" kind: render ONE question at a time (sequential). custom_id and
// select values carry the ORIGINAL option index (o.value), so the answer maps
// back by index regardless of any options dropped during normalization.
function buildQuestionBody(pending) {
  const handle = pending.handle;
  const qIdx = pending.qIndex;
  const total = pending.questions.length;
  const q = pending.questions[qIdx];
  const useSelect = !!q.multiSelect || q.options.length > 5;
  const lines = [];
  if (total > 1) lines.push(`Question ${qIdx + 1} of ${total}`);
  lines.push(q.question);
  if (!useSelect) {
    for (const o of q.options) {
      if (o.description) lines.push(`• ${o.label} — ${o.description}`);
    }
  }
  const description = clip(lines.join("\n\n"), 4096);
  const rows = [];
  if (useSelect) {
    rows.push({
      type: COMP_ACTION_ROW,
      components: [{
        type: COMP_STRING_SELECT,
        custom_id: `qsel:${handle}:${qIdx}`,
        placeholder: "Select…",
        min_values: 1,
        max_values: q.multiSelect ? Math.min(q.options.length, 25) : 1,
        options: q.options.map((o) => {
          const opt = { label: clip(o.label, 100), value: String(o.value) };
          if (o.description) opt.description = clip(o.description, 100);
          return opt;
        }),
      }],
    });
    rows.push({
      type: COMP_ACTION_ROW,
      components: [
        { type: COMP_BUTTON, style: BTN_SUCCESS, label: "Confirm", custom_id: `qok:${handle}:${qIdx}` },
        { type: COMP_BUTTON, style: BTN_SECONDARY, label: "Other…", custom_id: `qother:${handle}:${qIdx}` },
      ],
    });
  } else {
    const btns = q.options.map((o) => ({
      type: COMP_BUTTON, style: BTN_PRIMARY, label: clip(o.label, 80),
      custom_id: `qopt:${handle}:${qIdx}:${o.value}`,
    }));
    for (let i = 0; i < btns.length; i += 5) {
      rows.push({ type: COMP_ACTION_ROW, components: btns.slice(i, i + 5) });
    }
    rows.push({
      type: COMP_ACTION_ROW,
      components: [{ type: COMP_BUTTON, style: BTN_SECONDARY, label: "Other…", custom_id: `qother:${handle}:${qIdx}` }],
    });
  }
  return {
    embeds: [{ title: clip(pending.payload.title || "Question", 256), description }],
    components: rows,
  };
}

function buildCardBody(handle, payload) {
  return {
    embeds: [{ title: clip(payload.title || "Approval request", 256), description: clip(payload.detail || "", 4096) }],
    components: buildApprovalComponents(handle, payload),
  };
}

// Initial message body for a pending request, dispatched by kind.
function buildInitialBody(pending) {
  if (pending.kind === "question") return buildQuestionBody(pending);
  const components = pending.kind === "plan"
    ? buildPlanComponents(pending.handle)
    : buildApprovalComponents(pending.handle, pending.payload);
  return {
    embeds: [{ title: clip(pending.payload.title || "Approval request", 256), description: clip(pending.payload.detail || "", 4096) }],
    components,
  };
}

function buildNeutralizedBody(payload, outcomeLine) {
  const base = String(payload.detail || "");
  const description = clip(`${base}\n\n${outcomeLine}`, 4096);
  return {
    embeds: [{ title: clip(payload.title || "Approval request", 256), description }],
    components: [],
  };
}

function buildOtherModal(handle, qIdx, questionText) {
  const label = clip(questionText || "Your answer", 45);
  return {
    type: CALLBACK_MODAL,
    data: {
      custom_id: `qothermodal:${handle}:${qIdx}`,
      title: label,
      components: [{
        type: COMP_ACTION_ROW,
        components: [{ type: COMP_TEXT_INPUT, custom_id: "answer", style: TEXT_INPUT_SHORT, label, required: true, max_length: 300 }],
      }],
    },
  };
}

function buildPlanFeedbackModal(handle) {
  return {
    type: CALLBACK_MODAL,
    data: {
      custom_id: `planmodal:${handle}`,
      title: "Request changes",
      components: [{
        type: COMP_ACTION_ROW,
        components: [{ type: COMP_TEXT_INPUT, custom_id: "feedback", style: TEXT_INPUT_PARAGRAPH, label: "What should change?", required: true, max_length: 1000 }],
      }],
    },
  };
}

function modalText(interaction) {
  const rows = interaction && interaction.data && Array.isArray(interaction.data.components)
    ? interaction.data.components : [];
  for (const row of rows) {
    const comps = row && Array.isArray(row.components) ? row.components : [];
    for (const c of comps) {
      if (c && typeof c.value === "string") return c.value;
    }
  }
  return "";
}

function outcomeText(kind) {
  if (kind === "allow") return "✅ Approved via Discord";
  if (kind === "deny") return "⛔ Denied via Discord";
  if (kind === "suggestion") return "✅ Approved with an option via Discord";
  if (kind === "answer") return "✅ Answered via Discord";
  if (kind === "plan-approved") return "✅ Plan approved via Discord";
  if (kind === "plan-deny") return "↩︎ Sent back for changes via Discord";
  return "↩︎ Resolved on another surface";
}

// Raw-https REST client. Each method resolves with parsed JSON (or null) on 2xx
// and rejects with an Error carrying `.status` and Discord `.code` otherwise.
function createDiscordRestClient({ token, https = require("https"), agent, log = () => {} } = {}) {
  // One warm keep-alive connection reused across calls (post, ack, neutralize)
  // so we skip a fresh TLS handshake each time — matters most from high-RTT
  // regions where every round trip to discord.com is ~300ms+.
  const keepAliveAgent = agent || new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 8 });
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
          agent: keepAliveAgent,
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
    // The owner's DM channel id is stable; open it once and reuse it so every
    // approval after the first skips a cross-continent round trip.
    this._dmChannelId = "";
  }

  isEnabled() {
    return !!(this.token && this.ownerUserId);
  }

  // The remote-approval registry only routes "plan"/"question" kinds to adapters
  // that opt in here; Telegram has no canHandle, so it stays approval-only.
  canHandle(kind) {
    return kind === "approval" || kind === "plan" || kind === "question";
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
    const kind = payload.kind === "plan" || payload.kind === "question" ? payload.kind : "approval";
    if (kind === "question" && !(Array.isArray(payload.questions) && payload.questions.length)) {
      return Promise.resolve(null);
    }

    const handle = this._mintHandle();
    return new Promise((resolve) => {
      let settled = false;
      const pending = {
        handle,
        payload,
        kind,
        questions: kind === "question" ? payload.questions : null,
        qIndex: 0,
        answers: {},     // { [questionIndex]: { selected: number[], other?: string } }
        sel: {},         // staged select-menu values awaiting "Confirm"
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
        else if (decision && (decision.action === "suggestion" || decision.action === "answer" || decision.action === "deny")) resolve(decision);
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

  async _ensureDMChannel() {
    if (this._dmChannelId) return this._dmChannelId;
    const dm = await this.rest.createDMChannel(this.ownerUserId);
    this._dmChannelId = (dm && dm.id) || "";
    return this._dmChannelId;
  }

  async _postCard(pending) {
    const body = buildInitialBody(pending);
    const startedAt = Date.now();
    try {
      const channelId = await this._ensureDMChannel();
      const msg = await this.rest.createMessage(channelId, body);
      this._log("info", `card posted in ${Date.now() - startedAt}ms`);
      return { channelId, messageId: msg && msg.id };
    } catch (err) {
      if (err && Number(err.code) === ERR_CANNOT_DM && this.fallbackChannelId) {
        try {
          const msg = await this.rest.createMessage(this.fallbackChannelId, body);
          this._log("info", `card posted to fallback channel in ${Date.now() - startedAt}ms`);
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
    if (!interaction) return;
    // 3 = MESSAGE_COMPONENT (button / select), 5 = MODAL_SUBMIT.
    if (interaction.type !== 3 && interaction.type !== 5) return;
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

    switch (parsed.type) {
      case "approve":
        this._ackDeferred(interaction);
        this._neutralize(pending, outcomeText(pending.kind === "plan" ? "plan-approved" : "allow"));
        pending.finish("allow");
        return;
      case "deny":
        this._ackDeferred(interaction);
        this._neutralize(pending, outcomeText(pending.kind === "plan" ? "plan-deny" : "deny"));
        // Plan "Keep planning" is a deny with no specific feedback.
        pending.finish(pending.kind === "plan" ? { action: "deny" } : "deny");
        return;
      case "suggestion":
        this._ackDeferred(interaction);
        this._neutralize(pending, outcomeText("suggestion"));
        pending.finish({ action: "suggestion", index: parsed.index });
        return;
      case "planmod":
        // Opening the modal IS the ACK — do not also send a deferred update.
        this._respond(interaction, buildPlanFeedbackModal(pending.handle));
        return;
      case "planmodal": {
        const feedback = modalText(interaction).trim();
        this._ackDeferred(interaction);
        this._neutralize(pending, outcomeText("plan-deny"));
        pending.finish(feedback ? { action: "deny", message: feedback } : { action: "deny" });
        return;
      }
      case "qopt":
        pending.answers[parsed.q] = { selected: [parsed.o] };
        this._advanceQuestion(interaction, pending);
        return;
      case "qsel":
        pending.sel[parsed.q] = (Array.isArray(data.values) ? data.values : [])
          .map((v) => Number(v)).filter((n) => Number.isInteger(n));
        this._ackDeferred(interaction); // keep the card; wait for Confirm
        return;
      case "qok":
        pending.answers[parsed.q] = { selected: pending.sel[parsed.q] || [] };
        this._advanceQuestion(interaction, pending);
        return;
      case "qother": {
        const q = pending.questions[parsed.q];
        this._respond(interaction, buildOtherModal(pending.handle, parsed.q, q && q.question));
        return;
      }
      case "qothermodal":
        pending.answers[parsed.q] = { selected: [], other: modalText(interaction).trim() };
        this._advanceQuestion(interaction, pending);
        return;
      default:
        return;
    }
  }

  _respond(interaction, payload) {
    Promise.resolve(this.rest.interactionCallback(interaction.id, interaction.token, payload))
      .catch((err) => this._log("warn", `discord interaction response failed: ${err && err.message}`));
  }

  _ackDeferred(interaction) {
    this._respond(interaction, { type: CALLBACK_DEFERRED_UPDATE });
  }

  // Sequential questions: rewrite the source message to the next question, or
  // finish with the accumulated answers when the last one is done.
  _advanceQuestion(interaction, pending) {
    pending.qIndex += 1;
    if (pending.qIndex < pending.questions.length) {
      this._respond(interaction, { type: CALLBACK_UPDATE_MESSAGE, data: buildQuestionBody(pending) });
      return;
    }
    pending.neutralized = true;
    this._respond(interaction, { type: CALLBACK_UPDATE_MESSAGE, data: buildNeutralizedBody(pending.payload, outcomeText("answer")) });
    pending.finish({ action: "answer", answers: pending.answers });
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
  buildApprovalComponents,
  buildPlanComponents,
  buildQuestionBody,
  buildInitialBody,
  buildCardBody,
  buildNeutralizedBody,
  buildOtherModal,
  buildPlanFeedbackModal,
  modalText,
  outcomeText,
};

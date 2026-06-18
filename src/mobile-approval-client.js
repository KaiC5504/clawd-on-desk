"use strict";

// Remote-approval adapter for the iPhone PWA. Mirrors the TelegramApprovalClient
// contract (isEnabled / requestApproval(payload,{signal}) -> Promise<decision|null>,
// settled-guarded finish, abort + fail-safe null) but drives the mobile-preview
// server's WebSocket/push transport instead of an HTTP endpoint. Scope matches
// what upstream/main's permission seam normalizes: allow / deny / suggestion.

const crypto = require("crypto");

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // a dark phone must never leak a handle

function isRecognizedDecision(d) {
  if (d === "allow" || d === "deny") return true;
  if (d && typeof d === "object") {
    const action = d.action || d.decision;
    if (action === "allow" || action === "deny") return true;
    if (d.action === "suggestion" && Number.isInteger(Number(d.index))) return true;
  }
  return false;
}

function outcomeLabel(decision) {
  if (decision === "allow" || (decision && (decision.action === "allow" || decision.decision === "allow"))) return "Allowed";
  if (decision === "deny" || (decision && (decision.action === "deny" || decision.decision === "deny"))) return "Denied";
  if (decision && decision.action === "suggestion") return "Updated";
  return "Handled elsewhere";
}

class MobileApprovalClient {
  constructor(options = {}) {
    this._getTransport = typeof options.getTransport === "function" ? options.getTransport : () => null;
    this._timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, Number(options.timeoutMs)) : DEFAULT_TIMEOUT_MS;
    this._pending = new Map(); // handle -> { finish }
    this._boundTransport = null;
  }

  // Re-bind the single decision listener whenever the transport instance changes
  // (e.g. the server was stopped and restarted).
  _ensureListener(transport) {
    if (!transport || transport === this._boundTransport) return;
    if (typeof transport.onDecision === "function") {
      transport.onDecision((handle, decision) => this._onDecision(handle, decision));
    }
    this._boundTransport = transport;
  }

  isEnabled() {
    const t = this._getTransport();
    if (!t) return false;
    if (typeof t.isApprovalsEnabled === "function" && !t.isApprovalsEnabled()) return false;
    const hasClients = typeof t.hasClients === "function" && t.hasClients();
    const hasPush = typeof t.hasPushSub === "function" && t.hasPushSub();
    return !!(hasClients || hasPush);
  }

  requestApproval(payload, options = {}) {
    const transport = this._getTransport();
    if (!transport || typeof transport.pushApproval !== "function") return Promise.resolve(null);
    if (!payload || !payload.title) return Promise.resolve(null);
    this._ensureListener(transport);

    const signal = options.signal;
    if (signal && signal.aborted) return Promise.resolve(null);

    const handle = crypto.randomBytes(8).toString("hex");

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;

      const finish = (decision) => {
        if (settled) return;
        settled = true;
        this._pending.delete(handle);
        if (timer) clearTimeout(timer);
        if (signal) { try { signal.removeEventListener("abort", onAbort); } catch {} }
        try { transport.neutralizeApproval(handle, outcomeLabel(decision)); } catch {}
        resolve(decision == null ? null : decision);
      };

      const onAbort = () => finish(null);

      this._pending.set(handle, { finish });
      if (signal) { try { signal.addEventListener("abort", onAbort, { once: true }); } catch {} }
      if (this._timeoutMs > 0) timer = setTimeout(() => finish(null), this._timeoutMs);

      try {
        transport.pushApproval(handle, {
          title: payload.title,
          detail: payload.detail || "",
          suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : undefined,
        }, options.sessionId);
      } catch {
        finish(null);
      }
    });
  }

  // Routed here from the server when a phone submits approval_decision {handle,decision}.
  // Unrecognized decisions are ignored (not finished) so a fat-finger payload can't
  // silently consume a pending approval.
  _onDecision(handle, decision) {
    const pending = this._pending.get(handle);
    if (!pending) return;
    if (!isRecognizedDecision(decision)) return;
    pending.finish(decision);
  }

  stop() {
    for (const p of [...this._pending.values()]) { try { p.finish(null); } catch {} }
    this._pending.clear();
    this._boundTransport = null;
  }
}

module.exports = { MobileApprovalClient, isRecognizedDecision };

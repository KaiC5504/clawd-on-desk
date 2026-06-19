(function() {
  "use strict";

  // === Constants ===

  var STATE_CONFIG = {
    error:        { icon: "error",        color: "#ef4444", priority: 0, labelKey: "state_error" },
    attention:    { icon: "attention",    color: "#b45309", priority: 1, labelKey: "state_attention" },
    working:      { icon: "working",      color: "#22c55e", priority: 2, labelKey: "state_working" },
    juggling:     { icon: "juggling",     color: "#22c55e", priority: 2, labelKey: "state_juggling" },
    thinking:     { icon: "thinking",     color: "#3b82f6", priority: 3, labelKey: "state_thinking" },
    notification: { icon: "notification", color: "#d97757", priority: 4, labelKey: "state_notification" },
    sweeping:     { icon: "sweeping",     color: "#71717a", priority: 5, labelKey: "state_sweeping" },
    carrying:     { icon: "carrying",     color: "#71717a", priority: 5, labelKey: "state_carrying" },
    idle:         { icon: "idle",         color: "#71717a", priority: 6, labelKey: "state_idle" },
    sleeping:     { icon: "sleeping",     color: "#a1a1aa", priority: 7, labelKey: "state_sleeping" },
  };

  var CONNECTION_STATES = {
    connected:    { dot: "connected", textKey: "conn_connected", color: "#22c55e" },
    connecting:   { dot: "connecting", textKey: "conn_connecting", color: "#b45309" },
    reconnecting: { dot: "reconnecting", textKey: "conn_reconnecting", color: "#ef4444" },
    disconnected: { dot: "", textKey: null, color: "#52525b" },
    auth_failed:  { dot: "", textKey: "conn_auth_failed", color: "#ef4444" },
  };


  var MAX_HISTORY = 5;
  var MAX_LOG_LINES = 200;
  var _logBuffer = [];

  // === i18n ===
  // Strings + language resolution live in pwa/i18n.js (window.CLAWD_I18N). t() is
  // bound here; the active language is chosen during App init and via the Settings
  // language picker, with a full re-render on change.
  function t(key, vars) { return CLAWD_I18N.t(key, vars); }

  // Bridge for qr-scan.js — it loads as a separate <script>, outside this IIFE,
  // so it reaches t()/showToast through these globals.
  window.clawdT = function(key, vars) { return t(key, vars); };

  // === Utilities ===

  function esc(str) {
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function icon(name) {
    return (typeof ICONS !== "undefined" && ICONS[name]) || "";
  }

  // The desktop is always reachable on the LAN (RFC1918 / loopback / link-local /
  // CGNAT-Tailscale / .local). A scanned QR may only re-point at such a host, so a
  // malicious "https://attacker.example/mobile/" QR can never steer the durable
  // credential to an internet-routable server — TLS won't save us there (the phone
  // trusts any publicly-valid cert), but refusing public hosts outright does.
  function isLanHost(host) {
    if (!host) return false;
    var h = String(host).toLowerCase();
    if (h === "localhost" || h === "::1" || /\.local$/.test(h)) return true;
    if (/^fe80:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h)) return true; // IPv6 link-local / ULA
    var m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
    if (!m) return false;
    var a = +m[1], b = +m[2];
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / Tailscale
    return false;
  }

  // Pairing code is Crockford base32 (no I/L/O/U). Be forgiving on input: map the
  // decode aliases (O→0, I/L→1), uppercase, and drop separators / stray chars.
  var CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  function normalizeCode(str) {
    var aliased = String(str || "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
    var out = "";
    for (var i = 0; i < aliased.length; i++) {
      if (CODE_ALPHABET.indexOf(aliased[i]) !== -1) out += aliased[i];
    }
    return out;
  }

  function shortPath(p) {
    if (!p) return "";
    var parts = p.split(/[/\\]/);
    return parts.length > 3 ? ".../" + parts.slice(-2).join("/") : p;
  }

  function formatAgo(ts) {
    if (!ts) return "";
    var sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 5) return t("time_just_now");
    if (sec < 60) return t("time_sec_ago", { n: sec });
    if (sec < 3600) return t("time_min_ago", { n: Math.floor(sec / 60) });
    return t("time_hr_ago", { n: Math.floor(sec / 3600) });
  }

  // Labels live in the i18n dictionary (event_*); EVENT_ICONS lives in icons.js.
  function eventLabel(eventName) {
    var key = "event_" + eventName;
    if (CLAWD_I18N.I18N[key]) return t(key);
    return (typeof EVENT_LABELS !== "undefined" && EVENT_LABELS[eventName]) || eventName || "";
  }

  function eventIcon(eventName) {
    return icon((typeof EVENT_ICONS !== "undefined" && EVENT_ICONS[eventName]) || "dot");
  }

  function log(msg) {
    var now = new Date();
    var ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map(function(n) { return String(n).padStart(2, "0"); }).join(":");
    var line = "[" + ts + "] " + msg;
    _logBuffer.push(line);
    if (_logBuffer.length > MAX_LOG_LINES) _logBuffer.shift();
    var el = document.getElementById("settings-log-content");
    if (el) {
      var div = document.createElement("div");
      div.textContent = line;
      el.appendChild(div);
      el.scrollTop = el.scrollHeight;
    }
  }

  function showToast(message, type, persist) {
    type = type || "info";
    var container = document.getElementById("toast-container");
    var toast = document.createElement("div");
    toast.className = "toast " + type + (persist ? " toast-persist" : "");
    toast.textContent = message;
    if (persist) {
      var close = document.createElement("span");
      close.className = "toast-close";
      close.innerHTML = icon("close");
      close.onclick = function() { toast.remove(); };
      toast.appendChild(close);
    }
    container.appendChild(toast);
    if (!persist) {
      setTimeout(function() {
        toast.style.opacity = "0";
        toast.style.transition = "opacity 0.3s";
        setTimeout(function() { toast.remove(); }, 300);
      }, 3000);
    }
  }

  window.clawdToast = function(message, type) { return showToast(message, type); };

  // === NotificationManager ===

  class NotificationManager {
    constructor() { this.permission = "default"; this.lastStates = new Map(); }

    requestPermission() {
      if (!("Notification" in window)) return;
      if (Notification.permission === "granted") { this.permission = "granted"; return; }
      if (Notification.permission !== "denied") {
        var self = this;
        Notification.requestPermission().then(function(p) { self.permission = p; });
      }
    }

    onStateChange(sessionId, data) {
      if (this.permission !== "granted" || document.visibilityState === "visible") return;
      var prev = this.lastStates.get(sessionId);
      this.lastStates.set(sessionId, data.state);
      var s = data.state;
      var config = STATE_CONFIG[s];
      if (!config) return;
      var label = data.title || data.agentId || "Agent";
      if (s === "error" || s === "attention") {
        this._notify(t(config.labelKey), label + " - " + t(config.labelKey), s);
      } else if ((prev === "working" || prev === "thinking") && s === "idle") {
        this._notify(t("notif_task_done_title"), t("notif_task_done_body", { label: label }), "idle");
      }
    }

    _notify(title, body, tag) {
      try {
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
          navigator.serviceWorker.ready.then(function(reg) {
            reg.showNotification(title, { body: body, tag: "clawd-" + (tag || "default"), icon: "/mobile/icons/icon-256.png" });
          });
        } else {
          new Notification(title, { body: body, tag: "clawd-" + (tag || "default") });
        }
      } catch {}
    }
  }

  // === ConnectionManager ===

  class ConnectionManager {
    constructor() {
      this.ws = null; this.config = null;
      this.reconnectDelay = 1000; this.maxReconnectDelay = 30000;
      this.reconnectTimer = null; this.state = "disconnected";
      this.retryCount = 0;
      this.onStateChange = null; this.onMessage = null; this.onDisconnected = null;
      this.onOpen = null; this.onNeedsPairing = null; this.onCodeError = null;
      this.onResolveTarget = null;
      this._hiddenAt = 0;
      this._hasConnectedOnce = false;
      this._candidateIdx = 0;
      this._connectSeq = 0;
      this._endpointRecorded = false;
      this.deviceId = this._loadDeviceId();
      this.paired = this._loadPairing();
      this._triedDurable = false;
      this._triedCode = false;
      this._needCode = false;
      this._bindVisibility();
    }

    _loadDeviceId() {
      var id = "";
      try { id = localStorage.getItem("clawd-device-id") || ""; } catch {}
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
        id = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID()
          : "dev-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
        try { localStorage.setItem("clawd-device-id", id); } catch {}
      }
      return id;
    }

    _loadPairing() {
      try { return JSON.parse(localStorage.getItem("clawd-pairing") || "null"); } catch { return null; }
    }

    savePairing(deviceId, secret) {
      this.paired = { deviceId: deviceId, secret: secret };
      try { localStorage.setItem("clawd-pairing", JSON.stringify(this.paired)); } catch {}
      // The bootstrap code did its job — drop it so reconnects use the durable
      // credential, never a stale (now-consumed) code.
      if (this.config) this.config.code = null;
    }

    // Bootstrap pairing by typing the desktop's short code. The installed app is
    // served by the desktop, so location gives the WS target for free — the user
    // only supplies the code.
    connectWithCode(code) {
      var host = (typeof location !== "undefined") ? location.hostname : "";
      var port = (typeof location !== "undefined") ? parseInt(location.port, 10) : 0;
      var secure = (typeof location !== "undefined") && location.protocol === "https:";
      this.connect({ host: host, port: port, code: code, secure: secure });
    }

    isPaired() { return !!(this.paired && this.paired.secret); }
    // The server accepts approval/focus writes only over wss or loopback, so the
    // UI must match that gate to avoid offering buttons that get silently dropped.
    isSecureConnection() {
      if (!this.config) return false;
      if (this.config.secure) return true;
      var h = this.config.host;
      return h === "127.0.0.1" || h === "::1" || h === "localhost";
    }

    _deviceLabel() {
      var ua = (navigator.userAgent || "");
      if (/iPhone/i.test(ua)) return "iPhone";
      if (/iPad/i.test(ua)) return "iPad";
      if (/Android/i.test(ua)) return "Android";
      return "Mobile";
    }

    connect(config) {
      this.config = config;
      this._needCode = false; // an explicit connect attempt lifts the code-entry suspension
      this.retryCount = 0;
      this.reconnectDelay = 1000;
      this._candidateIdx = 0;
      clearTimeout(this.reconnectTimer);
      this._saveToHistory(config);
      this._doConnect();
    }

    // Re-point the installed app at a scanned address. A paired device reconnects
    // with its durable credential (the QR carries no token); an unpaired device
    // rides any token the QR happens to include. Either way the page never
    // navigates — only the WS target moves, so the frozen launch URL is irrelevant.
    repoint(target) {
      if (!target || !target.host || !target.port) return false;
      this.connect({ host: target.host, port: target.port, secure: !!target.secure, token: target.token || null });
      return true;
    }

    // Local forget: clear this phone's pairing and return to a clean disconnected
    // state. The desktop list stays authoritative — the old secret is valid there
    // until revoked. clawd-history is dropped too so _autoConnect won't re-target a
    // dead port; clawd-device-id is kept so a re-pair reuses the stable id.
    forget() {
      clearTimeout(this.reconnectTimer);
      var old = this.ws;
      if (old) {
        old.onopen = old.onmessage = old.onclose = old.onerror = null;
        try { old.close(); } catch {}
      }
      this.ws = null;
      this.paired = null;
      this._needCode = true;
      this.config = null;
      try { localStorage.removeItem("clawd-pairing"); } catch {}
      try { localStorage.removeItem("clawd-history"); } catch {}
      try { localStorage.removeItem("clawd-endpoints"); } catch {}
      this._setState("disconnected");
      log("Disconnected from desktop");
    }

    _doConnect() {
      if (!this.config) return;
      // Each attempt gets a generation id so an async rotation that resolves late
      // can tell it was superseded by a foreground reconnect or a user scan.
      this._connectSeq++;
      this._endpointRecorded = false;
      // Tear down old socket — clear callbacks first to prevent stale events
      var old = this.ws;
      if (old) {
        old.onopen = old.onmessage = old.onclose = old.onerror = null;
        try { old.close(); } catch {}
      }
      // Auth precedence: durable per-device credential (survives token rotation)
      // → a typed pairing code (camera-free bootstrap) → the one-time URL token.
      // _forceToken skips durable after a rejected durable connect so we can
      // re-bootstrap from whatever credential is still on hand.
      var auth;
      if (this.isPaired() && !this._forceToken) {
        this._triedDurable = true;
        this._triedCode = false;
        auth = "deviceId=" + encodeURIComponent(this.paired.deviceId) + "&secret=" + encodeURIComponent(this.paired.secret);
      } else if (this.config.code) {
        this._triedDurable = false;
        this._triedCode = true;
        auth = "code=" + encodeURIComponent(this.config.code);
      } else {
        this._triedDurable = false;
        this._triedCode = false;
        auth = "token=" + encodeURIComponent(this.config.token || "");
      }
      // An https-served page can only open a wss socket (ws:// is blocked as mixed
      // content), so trust the page scheme over the stored flag.
      var secure = this.config.secure || (typeof location !== "undefined" && location.protocol === "https:");
      var url = (secure ? "wss://" : "ws://") + this.config.host + ":" + this.config.port + "/ws?" + auth;
      this._setState("connecting");
      log("Connecting to " + this.config.host + ":" + this.config.port + "...");
      var socket;
      try { socket = new WebSocket(url); } catch (err) { log("WS create failed: " + err.message); this._scheduleReconnect(); return; }
      this.ws = socket;
      var self = this;
      var connected = false;
      // Bound the attempt: an unreachable host (a stale IP after moving networks)
      // would otherwise hang the socket for the OS TCP timeout (~30-75s), stalling
      // reconnect/rotation. If OPEN doesn't arrive in time, drop it and retry.
      var connectTimer = setTimeout(function() {
        if (socket !== self.ws || connected) return;
        log("Connect timed out");
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        try { socket.close(); } catch {}
        self._scheduleReconnect();
      }, 6000);
      socket.onopen = function() {
        if (socket !== self.ws) return; // stale socket — ignore
        clearTimeout(connectTimer);
        connected = true; self.retryCount = 0; self.reconnectDelay = 1000; self._forceToken = false; self._candidateIdx = 0;
        self._setState("connected"); log("Connected");
        // Announce only on the genuine first pairing. An already-paired device is
        // "still connected" — a foreground reconnect or a cold relaunch just updates
        // the header dot silently. (_hasConnectedOnce guards a double-toast in the
        // brief window before the first pairing credential is stored.)
        if (!self.isPaired() && !self._hasConnectedOnce) { self._hasConnectedOnce = true; showToast(t("toast_connected"), "success"); }
        // Dismiss any persistent toasts (e.g. retry hint)
        var persisted = document.querySelectorAll(".toast-persist");
        for (var i = 0; i < persisted.length; i++) { persisted[i].remove(); }
        // v2 unlocks approval/detail traffic; must be sent every open.
        self.send({ type: "client_hello", protocol: "v2" });
        // First-time pairing rides any bootstrap credential (URL token or typed
        // code); a durable connection is already paired.
        if (!self.isPaired() && (self.config.token || self.config.code)) {
          self.send({ type: "pair", deviceId: self.deviceId, label: self._deviceLabel() });
        }
        if (self.onOpen) self.onOpen();
        // NOTE: do NOT strip the query string here. iOS "Add to Home Screen"
        // captures the current URL as the icon's launch URL, and the installed app
        // gets a fresh empty storage container — so the token in the URL is the
        // only way it can bootstrap its first pairing. _autoConnect already prefers
        // a stored credential over a lingering URL token, so keeping it is safe.
      };
      socket.onmessage = function(event) {
        if (socket !== self.ws) return;
        try {
          var msg = JSON.parse(event.data);
          // Record the address as known-good only once the desktop actually accepts
          // this device (a real authenticated message), not on the bare WS upgrade —
          // a host that merely answers /ws must not be able to seed the rotation.
          if (!self._endpointRecorded && msg && (msg.type === "snapshot" || msg.type === "approval_snapshot" || msg.type === "paired")) {
            self._endpointRecorded = true;
            self._recordEndpoint(self.config.host, self.config.port, secure);
          }
          if (self.onMessage) self.onMessage(msg);
        } catch {}
      };
      socket.onclose = function(event) {
        if (socket !== self.ws) return; // stale socket — ignore
        clearTimeout(connectTimer);
        if (event.code === 1008) {
          // A rejected durable connect means the device was revoked (or the
          // registry was reset). Drop the stale pairing; re-bootstrap if a
          // token/code is still on hand, else fall back to the code-entry UI.
          if (self._triedDurable) {
            self.paired = null;
            try { localStorage.removeItem("clawd-pairing"); } catch {}
            if (self.config.token || self.config.code) {
              log("Durable auth rejected, re-pairing");
              self._forceToken = true;
              self._doConnect();
              return;
            }
            // Revoked with nothing left to bootstrap from — park on the
            // code-entry screen and stop auto-reconnecting until a code arrives.
            self._needCode = true;
            self._setState("disconnected"); log("Device unpaired on the desktop — pair again with a code");
            if (self.onNeedsPairing) self.onNeedsPairing();
            return;
          }
          // A rejected code: invalid or expired. Drop the dead code and suspend
          // auto-reconnect (otherwise every foreground would retry it) until the
          // user submits a fresh one.
          if (self._triedCode) {
            self.config.code = null;
            self._needCode = true;
            self._setState("disconnected"); log("Pairing code rejected or expired");
            if (self.onCodeError) self.onCodeError();
            return;
          }
          self._setState("auth_failed"); log("Auth failed"); showToast(t("toast_token_expired"), "error"); return;
        }
        if (connected) log("Disconnected (code: " + event.code + ")");
        if (self.onDisconnected) self.onDisconnected();
        self._scheduleReconnect();
      };
      socket.onerror = function() {};
    }

    send(data) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(typeof data === "string" ? data : JSON.stringify(data)); }

    _scheduleReconnect() {
      if (!this.config) return;
      this.retryCount++;
      this._setState("reconnecting");
      // After several retries, give actionable feedback (don't stop — just inform)
      if (this.retryCount === 5) {
        showToast(t("toast_reconnecting"), "info", true);
      }
      var self = this;
      this.reconnectTimer = setTimeout(function() {
        self.reconnectDelay = Math.min(self.reconnectDelay * 2, self.maxReconnectDelay);
        // Every few failed attempts, rotate to the next known address. This both
        // rediscovers a moved port on the same host (the live origin is candidate 0)
        // and recovers a paired device whose launch origin died — e.g. the laptop
        // moved networks and got a new IP — by cycling through the addresses it has
        // connected to before until one answers. Reset the backoff on a real switch
        // so each fresh candidate gets a fast first try instead of a 30s wait.
        if (self.config && self.retryCount % 3 === 0) {
          var seq = self._connectSeq;
          self._rotateTarget().then(function(rotated) {
            // A foreground reconnect or a user scan may have started a fresh attempt
            // while the live-origin probe was in flight — don't clobber it.
            if (self._connectSeq !== seq) return;
            if (rotated) self.reconnectDelay = 1000;
            self._doConnect();
          });
          return;
        }
        self._doConnect();
      }, this.reconnectDelay);
    }

    // Pick the next reconnect candidate from [live launch origin, ...known
    // endpoints], deduped by host:port. Resolves true only when it actually switched
    // to a different address (so the caller can reset the backoff). Never rejects —
    // the live-origin probe degrades to the frozen location target on failure.
    _rotateTarget() {
      var self = this;
      var prevKey = this.config ? this.config.host + ":" + this.config.port : "";
      var resolveLive = this.onResolveTarget
        ? Promise.resolve().then(function() { return self.onResolveTarget(); }).catch(function() { return null; })
        : Promise.resolve(null);
      return resolveLive.then(function(live) {
        var candidates = [];
        var seen = {};
        var push = function(c) {
          if (!c || !c.host || !c.port) return;
          var key = c.host + ":" + c.port;
          if (seen[key]) return;
          seen[key] = true;
          candidates.push({ host: c.host, port: c.port, secure: !!c.secure });
        };
        push(live);
        self._loadEndpoints().forEach(push);
        if (!self.config) return false;
        // One unique address: keep retrying it, but fold in any freshly-resolved
        // live port (the same-host, moved-port case the original self-heal handled).
        if (candidates.length < 2) {
          if (live) { self.config.host = live.host; self.config.port = live.port; self.config.secure = !!live.secure; }
          return (self.config.host + ":" + self.config.port) !== prevKey;
        }
        self._candidateIdx = (self._candidateIdx + 1) % candidates.length;
        var next = candidates[self._candidateIdx];
        self.config.host = next.host;
        self.config.port = next.port;
        self.config.secure = next.secure;
        return (next.host + ":" + next.port) !== prevKey;
      });
    }

    _setState(state) { this.state = state; if (this.onStateChange) this.onStateChange(state); }

    _saveToHistory(config) {
      var history = []; try { history = JSON.parse(localStorage.getItem("clawd-history") || "[]"); } catch {}
      var entry = { host: config.host, port: config.port, token: config.token, secure: !!config.secure, timestamp: Date.now() };
      var filtered = history.filter(function(h) { return h.host !== config.host || h.port !== config.port; });
      filtered.unshift(entry);
      localStorage.setItem("clawd-history", JSON.stringify(filtered.slice(0, MAX_HISTORY)));
    }

    getHistory() { try { return JSON.parse(localStorage.getItem("clawd-history") || "[]"); } catch { return []; } }
    deleteHistory(index) { var h = this.getHistory(); h.splice(index, 1); localStorage.setItem("clawd-history", JSON.stringify(h)); }

    _updateHistoryToken(host, port, newToken) {
      var history = this.getHistory();
      for (var i = 0; i < history.length; i++) {
        if (history[i].host === host && history[i].port === port) {
          history[i].token = newToken;
        }
      }
      localStorage.setItem("clawd-history", JSON.stringify(history));
    }

    // Known reachable addresses (durable re-point targets), separate from the
    // token-bearing clawd-history. Recorded only after the desktop authenticates
    // this device (see onmessage), so a host that merely answers /ws can't seed the
    // reconnect rotation.
    _loadEndpoints() {
      try { var a = JSON.parse(localStorage.getItem("clawd-endpoints") || "[]"); return Array.isArray(a) ? a : []; } catch { return []; }
    }
    getEndpoints() { return this._loadEndpoints(); }
    _recordEndpoint(host, port, secure) {
      if (!host || !port) return;
      var list = this._loadEndpoints().filter(function(e) { return !(e && e.host === host && e.port === port); });
      list.unshift({ host: host, port: port, secure: !!secure });
      try { localStorage.setItem("clawd-endpoints", JSON.stringify(list.slice(0, 5))); } catch {}
    }

    _bindVisibility() {
      var self = this;
      document.addEventListener("visibilitychange", function() {
        if (document.visibilityState !== "visible") {
          self._hiddenAt = Date.now();
          return;
        }
        if (!self.config) return;
        // Parked on the code-entry screen with no usable credential — don't spam
        // doomed connects on every foreground; wait for a fresh code.
        if (self._needCode) return;
        var hiddenFor = self._hiddenAt ? Date.now() - self._hiddenAt : 0;
        // Short tab switch: trust OPEN. Background > 30s: force reconnect (zombie guard)
        if (hiddenFor < 30000 && self.ws && self.ws.readyState === WebSocket.OPEN) return;
        log("Page visible after " + Math.round(hiddenFor / 1000) + "s, reconnecting...");
        self.retryCount = 0;
        self.reconnectDelay = 1000;
        clearTimeout(self.reconnectTimer);
        self._doConnect();
      });
    }
  }

  // === SessionRenderer ===

  class SessionRenderer {
    constructor(container) { this.container = container; this.sessions = new Map(); this.staleTimer = null; this.expandedSet = new Set(); this.onSelect = null; this.unpaired = false; this.onPair = null; this.onScan = null; this.canScan = false; this._startTimerUpdater(); }

    updateFromSnapshot(sessions) {
      this.sessions.clear();
      for (var sid in sessions) { if (sessions.hasOwnProperty(sid)) this.sessions.set(sid, sessions[sid]); }
      this.render();
    }

    updateState(sessionId, data) {
      var existing = this.sessions.get(sessionId) || {};
      var merged = {}; for (var k in existing) { if (existing.hasOwnProperty(k)) merged[k] = existing[k]; }
      for (var k2 in data) { if (data.hasOwnProperty(k2)) merged[k2] = data[k2]; }
      this.sessions.set(sessionId, merged);
      this.render();
    }

    removeSession(sessionId) { this.sessions.delete(sessionId); this.expandedSet.delete(sessionId); this.render(); }
    toggleExpand(sid) {
      var wasExpanded = this.expandedSet.has(sid);
      if (wasExpanded) this.expandedSet.delete(sid); else this.expandedSet.add(sid);
      this._animatingSid = sid;
      this.render();
    }

    render() {
      var self = this;
      var entries = [];
      this.sessions.forEach(function(v, k) { entries.push([k, v]); });
      entries.sort(function(a, b) {
        var pa = (STATE_CONFIG[a[1].state] || STATE_CONFIG.idle).priority;
        var pb = (STATE_CONFIG[b[1].state] || STATE_CONFIG.idle).priority;
        return pa - pb;
      });

      if (entries.length === 0) {
        if (this.unpaired) {
          this.container.innerHTML = '<div class="empty-state"><div class="empty-icon">' + icon("paw") + '</div>' +
            '<div class="empty-text">' + esc(t("pair_cta_settings")) + '</div>' +
            '<button class="empty-action" id="btn-go-settings">' + esc(t("pair_go_settings")) + '</button></div>';
          var goBtn = this.container.querySelector("#btn-go-settings");
          if (goBtn) goBtn.addEventListener("click", function() { if (self.onPair) self.onPair(); });
          return;
        }
        var scanCta = this.canScan
          ? '<button class="scan-cta" id="btn-scan-cta">' + icon("scan") + '<span>' + esc(t("scan_reconnect")) + '</span></button>'
          : '';
        this.container.innerHTML = '<div class="empty-state"><div class="empty-icon">' + icon("paw") + '</div>' +
          '<div class="empty-text">' + esc(t("empty_connect")) + '</div><div class="empty-hint">' + esc(t("empty_connect_hint")) + '</div>' + scanCta + '</div>';
        var scanBtn = this.container.querySelector("#btn-scan-cta");
        if (scanBtn) scanBtn.addEventListener("click", function() { if (self.onScan) self.onScan(); });
        return;
      }

      var html = '<div class="section-label">' + esc(t("sessions_active")) + ' &middot; ' + entries.length + '</div>';
      for (var i = 0; i < entries.length; i++) html += this._renderCard(entries[i][0], entries[i][1]);
      this.container.innerHTML = html;
      this.container.querySelectorAll(".card-footer").forEach(function(el) {
        el.addEventListener("click", function() { self.toggleExpand(this.getAttribute("data-sid")); });
      });
      this.container.querySelectorAll(".card-tap").forEach(function(el) {
        el.addEventListener("click", function() { if (self.onSelect) self.onSelect(this.getAttribute("data-sid")); });
      });
      if (this._animatingSid) {
        var animatingSid = this._animatingSid;
        this._animatingSid = null;
        if (this.expandedSet.has(animatingSid)) {
          var cards = this.container.querySelectorAll('.session-card');
          cards.forEach(function(card) {
            var footer = card.querySelector('.card-footer');
            if (footer && footer.getAttribute('data-sid') === animatingSid) {
              var eh = card.querySelector('.event-history');
              if (eh) requestAnimationFrame(function() { eh.classList.add('show'); });
            }
          });
        }
      }
    }

    _renderCard(sid, s) {
      var config = STATE_CONFIG[s.state] || STATE_CONFIG.idle;
      var isExpanded = this.expandedSet.has(sid);
      var events = s.recentEvents || [];
      var stateKey = s.state || "idle";
      var agentLabel = (s.agentId || "agent").toUpperCase();
      var sessionTitle = s.title || "";
      var html = '<div class="session-card">';
      html += '<div class="card-tap" data-sid="' + sid + '">';
      html += '<div class="card-header"><div class="card-agent"><div class="agent-dot"></div>';
      html += '<span class="agent-name">' + esc(agentLabel) + '</span></div>';
      html += '<span class="state-badge ' + stateKey + '">' + esc(t(config.labelKey)) + '</span></div>';
      if (sessionTitle) html += '<div class="card-title">' + esc(sessionTitle) + '</div>';
      html += '<div class="card-meta">';
      if (s.basename) { html += '<span class="meta-item mono">' + icon("folder") + '<span>' + esc(s.basename) + '</span></span>'; }
      if (s.updatedAt) { html += '<span class="meta-sep">&middot;</span><span class="meta-item meta-time" data-ts="' + s.updatedAt + '">' + formatAgo(s.updatedAt) + '</span>'; }
      html += '</div>';
      html += '</div>';
      html += '<div class="card-divider"></div>';
      html += '<div class="card-footer" data-sid="' + sid + '"><div class="footer-events">' + icon("activity") + '<span>' + esc(t("detail_events")) + '</span>';
      if (events.length) html += '<span class="event-count">' + events.length + '</span>';
      html += '</div><span class="footer-chevron">' + (isExpanded ? icon("collapse") : icon("expand")) + '</span></div>';
      if (events.length) html += this._renderEvents(events, isExpanded, this._animatingSid === sid);
      html += '</div>';
      return html;
    }

    _renderEvents(events, expanded, animate) {
      var showClass = (expanded && !animate) ? ' show' : '';
      var html = '<div class="event-history' + showClass + '"><div class="event-timeline">';
      for (var i = 0; i < events.length; i++) {
        var ev = events[i]; var c = STATE_CONFIG[ev.state] || STATE_CONFIG.idle;
        html += '<div class="event-row"><div class="event-dot" style="background:' + c.color + '"></div>';
        html += '<div class="event-line" style="background:' + c.color + '"></div>';
        html += '<span class="event-icon">' + eventIcon(ev.event) + '</span>';
        html += '<span class="event-label">' + esc(eventLabel(ev.event)) + '</span>';
        html += '<span class="event-time"' + (ev.at ? ' data-ts="' + ev.at + '"' : '') + '>' + formatAgo(ev.at) + '</span></div>';
      }
      return html + '</div></div>';
    }

    _startTimerUpdater() {
      var self = this;
      setInterval(function() {
        if (document.visibilityState !== 'visible') return;
        var els = self.container.querySelectorAll('.event-time[data-ts], .meta-time[data-ts]');
        for (var i = 0; i < els.length; i++) {
          var ts = parseInt(els[i].getAttribute('data-ts'), 10);
          if (!isNaN(ts)) els[i].textContent = formatAgo(ts);
        }
      }, 1000);
    }

    startStaleCleanup() {
      var self = this;
      this.staleTimer = setInterval(function() {
        var changed = false;
        self.sessions.forEach(function(s, sid) {
          if (s.state === "sleeping") { self.sessions.delete(sid); changed = true; }
        });
        if (changed) self.render();
      }, 15000);
    }
  }

  // === SettingsRenderer ===

  class SettingsRenderer {
    constructor(container) { this.container = container; this.onSubmitCode = null; this.onDisconnect = null; this.onScan = null; this.codeError = null; this._confirmDisconnect = false; }

    render(connection, push) {
      var html = '';

      // Connection status
      html += '<div class="settings-section">';
      html += '<div class="settings-section-title">' + esc(t("settings_connection")) + '</div>';
      var st = connection.state;
      var stCfg = CONNECTION_STATES[st] || CONNECTION_STATES.disconnected;
      html += '<div class="conn-status">';
      html += '<span class="conn-status-dot ' + stCfg.dot + '"></span>';
      html += '<span class="conn-status-text">' + esc(stCfg.textKey ? t(stCfg.textKey) : "") + '</span>';
      if (connection.config) html += '<span class="conn-status-addr">' + esc(connection.config.host) + ':' + connection.config.port + '</span>';
      html += '</div>';

      // Pairing status — paired shows a hint; unpaired shows the code-entry form.
      var paired = connection.isPaired();
      html += '<div class="settings-row"><span class="settings-label">' + esc(t("pair_section")) + '</span>';
      html += '<span class="settings-value">' + esc(paired ? t("pair_paired") : t("pair_unpaired")) + '</span></div>';
      if (paired) {
        html += '<div class="settings-hint">' + esc(t("pair_hint")) + '</div>';
        html += '<button class="settings-action-btn off scan-inline" id="btn-scan-reconnect">' + icon("scan") + '<span>' + esc(t("scan_reconnect")) + '</span></button>';
        html += '<button class="settings-action-btn off" id="btn-disconnect">' + esc(t("pair_disconnect")) + '</button>';
      } else {
        html += this._renderCodeEntry();
      }
      html += '</div>';

      // Language picker — defaults follow the desktop; a pick here persists.
      html += '<div class="settings-section">';
      html += '<div class="settings-section-title">' + esc(t("settings_language")) + '</div>';
      html += '<select class="settings-select" id="lang-select">';
      var langs = CLAWD_I18N.SUPPORTED_LANGS, langNames = CLAWD_I18N.LANG_NATIVE_NAMES, curLang = CLAWD_I18N.getLang();
      for (var lx = 0; lx < langs.length; lx++) {
        html += '<option value="' + langs[lx] + '"' + (langs[lx] === curLang ? ' selected' : '') + '>' + esc(langNames[langs[lx]]) + '</option>';
      }
      html += '</select>';
      html += '</div>';

      // Notifications (only meaningful for a paired device)
      if (paired && push && push.supported()) {
        html += '<div class="settings-section">';
        html += '<div class="settings-section-title">' + esc(t("notif_section")) + '</div>';
        html += '<button class="settings-action-btn off" id="btn-notif">' + icon("bell") + ' <span id="btn-notif-label">' + esc(t("notif_enable")) + '</span></button>';
        html += '<div class="settings-hint">' + esc(t("notif_hint")) + '</div>';
        html += '</div>';
      }

      // Log section (collapsed by default)
      html += '<div class="log-section">';
      html += '<button class="log-toggle" id="btn-toggle-log">' + esc(t("settings_log")) + ' (' + _logBuffer.length + ')</button>';
      html += '<div class="log-body" id="settings-log-content"></div>';
      html += '</div>';

      this.container.innerHTML = html;

      if (!paired) this._bindCodeEntry();

      // Render buffered log lines
      var logEl = document.getElementById("settings-log-content");
      if (logEl) {
        for (var li = 0; li < _logBuffer.length; li++) {
          var div = document.createElement("div");
          div.textContent = _logBuffer[li];
          logEl.appendChild(div);
        }
      }

      // Bind notifications toggle
      var notifBtn = document.getElementById("btn-notif");
      if (notifBtn && push) {
        var label = document.getElementById("btn-notif-label");
        var paint = function(on) {
          notifBtn.classList.toggle("on", on);
          notifBtn.classList.toggle("off", !on);
          if (label) label.textContent = on ? t("notif_disable") : t("notif_enable");
        };
        push.isSubscribed().then(paint);
        notifBtn.addEventListener("click", function() {
          var enabling = notifBtn.classList.contains("off");
          (enabling ? push.enable() : push.disable()).then(function(ok) {
            if (ok) paint(enabling);
          });
        });
      }

      // Bind disconnect — two-tap confirm (no native dialog) guards an accidental unpair.
      var disBtn = document.getElementById("btn-disconnect");
      if (disBtn) {
        var self = this;
        this._confirmDisconnect = false;
        disBtn.addEventListener("click", function() {
          if (!self._confirmDisconnect) {
            self._confirmDisconnect = true;
            disBtn.textContent = t("pair_disconnect_confirm");
            disBtn.classList.add("on");
            return;
          }
          self._confirmDisconnect = false;
          if (self.onDisconnect) self.onDisconnect();
        });
      }

      // Bind scan-to-reconnect (re-point the durable credential at a new address)
      var scanReBtn = document.getElementById("btn-scan-reconnect");
      if (scanReBtn) { var sr = this; scanReBtn.addEventListener("click", function() { if (sr.onScan) sr.onScan(); }); }

      // Bind language picker
      var langSel = document.getElementById("lang-select");
      if (langSel) langSel.addEventListener("change", function() { CLAWD_I18N.setLang(langSel.value); });

      // Bind log toggle
      var logToggle = document.getElementById("btn-toggle-log");
      var logBody = document.getElementById("settings-log-content");
      if (logToggle && logBody) {
        logToggle.addEventListener("click", function() {
          logToggle.classList.toggle("open");
          logBody.classList.toggle("open");
          if (logBody.classList.contains("open")) logBody.scrollTop = logBody.scrollHeight;
        });
      }
    }

    _renderCodeEntry() {
      // One real input captures all 8 chars; the cells are pure visuals that mirror
      // its value. Advancing focus between separate <input>s on every keystroke
      // churns the iOS keyboard (~0.4s stall per key), so focus never moves here.
      var cells = "";
      for (var i = 0; i < 8; i++) {
        if (i === 4) cells += '<span class="code-sep">&middot;</span>';
        cells += '<span class="code-box" data-idx="' + i + '"></span>';
      }
      var input = '<input class="code-input" type="text" inputmode="text" autocomplete="off"'
        + ' autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="8"'
        + ' aria-label="' + esc(t("pair_enter_title")) + '" />';
      var html = '<div class="pair-enter">';
      html += '<div class="pair-enter-title">' + esc(t("pair_enter_title")) + '</div>';
      html += '<div class="code-group">' + input + cells + '</div>';
      html += '<div class="code-error" id="code-error">' + (this.codeError ? esc(this.codeError) : "") + '</div>';
      html += '<button class="settings-action-btn off" id="btn-code-connect">' + esc(t("code_connect")) + '</button>';
      html += '<div class="settings-hint">' + esc(t("pair_enter_hint")) + '</div>';
      html += '</div>';
      return html;
    }

    _bindCodeEntry() {
      var self = this;
      var input = this.container.querySelector(".code-input");
      var group = this.container.querySelector(".code-group");
      var cells = Array.prototype.slice.call(this.container.querySelectorAll(".code-box"));
      if (!input || !cells.length) return;

      function showError(msg) {
        self.codeError = msg;
        var el = document.getElementById("code-error");
        if (el) el.textContent = msg || "";
      }
      function paint() {
        var v = normalizeCode(input.value).slice(0, cells.length);
        if (v !== input.value) input.value = v; // strip rejected chars, keep the field normalized
        var focused = group.classList.contains("focused");
        for (var i = 0; i < cells.length; i++) {
          cells[i].textContent = v[i] || "";
          cells[i].classList.toggle("filled", !!v[i]);
          cells[i].classList.toggle("active", focused && i === v.length && v.length < cells.length);
        }
        return v;
      }
      function submit() {
        var code = normalizeCode(input.value);
        if (code.length !== 8) { showError(t("code_invalid")); return; }
        showError("");
        if (self.onSubmitCode) self.onSubmitCode(code);
      }

      // Native input/backspace/paste all flow through one "input" event — no focus
      // hopping between elements, so the iOS keyboard never reconfigures mid-typing.
      input.addEventListener("input", function() { if (paint().length === 8) submit(); });
      input.addEventListener("focus", function() { group.classList.add("focused"); paint(); });
      input.addEventListener("blur", function() { group.classList.remove("focused"); paint(); });
      group.addEventListener("click", function() { input.focus(); });
      paint();

      var connectBtn = document.getElementById("btn-code-connect");
      if (connectBtn) connectBtn.addEventListener("click", submit);
    }
  }

  // === ApprovalRenderer ===

  class ApprovalRenderer {
    constructor(container) {
      this.container = container;
      this.approvals = new Map(); // handle -> { handle, sessionId, title, detail, suggestions }
      this.resolving = new Set(); // handles awaiting approval_resolved
      this.outcomes = new Map();  // handle -> outcome text shown briefly before removal
      this.paired = false;
      this.secure = false;        // server only accepts decisions over wss/loopback
      this.onDecision = null;     // (handle, decision) => void
    }

    setApproveContext(paired, secure) { this.paired = !!paired; this.secure = !!secure; this.render(); }

    seed(list) {
      this.approvals.clear();
      (list || []).forEach((a) => { if (a && a.handle) this.approvals.set(a.handle, a); });
      this.render();
    }

    add(a) { if (a && a.handle) { this.approvals.set(a.handle, a); this.resolving.delete(a.handle); this.render(); } }

    resolve(handle, outcome) {
      if (!this.approvals.has(handle)) return;
      this.resolving.delete(handle);
      if (outcome) {
        this.outcomes.set(handle, outcome);
        this.render();
        var self = this;
        setTimeout(function() { self.approvals.delete(handle); self.outcomes.delete(handle); self.render(); }, 1500);
      } else {
        this.approvals.delete(handle);
        this.render();
      }
    }

    submit(handle, decision) {
      this.resolving.add(handle);
      this.render();
      if (this.onDecision) this.onDecision(handle, decision);
    }

    render() {
      var self = this;
      if (this.approvals.size === 0) { this.container.innerHTML = ""; return; }
      var html = '<div class="section-label">' + esc(t("approval_pending")) + ' &middot; ' + this.approvals.size + '</div>';
      this.approvals.forEach(function(a) { html += self._renderCard(a); });
      this.container.innerHTML = html;
      this.container.querySelectorAll("[data-approve]").forEach(function(el) {
        el.addEventListener("click", function() {
          var handle = this.getAttribute("data-handle");
          var kind = this.getAttribute("data-approve");
          var decision;
          if (kind === "allow") decision = "allow";
          else if (kind === "deny") decision = "deny";
          else decision = { action: "suggestion", index: parseInt(this.getAttribute("data-index"), 10) };
          self.submit(handle, decision);
        });
      });
    }

    _renderCard(a) {
      var resolving = this.resolving.has(a.handle);
      var outcome = this.outcomes.get(a.handle);
      var html = '<div class="approval-card' + (resolving || outcome ? ' resolving' : '') + '">';
      html += '<div class="approval-head">' + icon("shield") + '<span class="approval-kind">' + esc(t("approval_kind")) + '</span></div>';
      if (a.title) html += '<div class="approval-title">' + esc(a.title) + '</div>';
      if (a.detail) html += '<div class="approval-detail">' + esc(a.detail) + '</div>';
      if (outcome) { html += '<div class="approval-outcome">' + esc(outcome) + '</div></div>'; return html; }
      if (!(this.paired && this.secure)) {
        var hintKey = this.paired ? "approval_secure_hint" : "approval_pair_hint";
        html += '<div class="approval-pair-hint">' + esc(t(hintKey)) + '</div></div>';
        return html;
      }
      html += '<div class="approval-actions">';
      html += '<button class="approval-btn allow" data-approve="allow" data-handle="' + esc(a.handle) + '">' + esc(t("approval_allow")) + '</button>';
      html += '<button class="approval-btn deny" data-approve="deny" data-handle="' + esc(a.handle) + '">' + esc(t("approval_deny")) + '</button>';
      html += '</div>';
      if (Array.isArray(a.suggestions) && a.suggestions.length) {
        html += '<div class="approval-suggestions">';
        for (var i = 0; i < a.suggestions.length; i++) {
          var sug = a.suggestions[i];
          html += '<button class="approval-chip" data-approve="suggestion" data-index="' + sug.index + '" data-handle="' + esc(a.handle) + '">' + esc(sug.label) + '</button>';
        }
        html += '</div>';
      }
      html += '</div>';
      return html;
    }
  }

  // === DetailRenderer ===

  class DetailRenderer {
    constructor(container) {
      this.container = container;
      this.sessionId = null;
      this.onClose = null;
      this.onFocus = null;
    }

    open(sessionId) {
      this.sessionId = sessionId;
      this.container.classList.remove("hidden");
      this._renderShell();
    }

    close() {
      this.sessionId = null;
      this.container.classList.add("hidden");
      this.container.innerHTML = "";
      if (this.onClose) this.onClose();
    }

    isOpen() { return this.sessionId !== null; }

    _renderShell() {
      var self = this;
      this.container.innerHTML =
        '<div class="detail-header"><button class="detail-back">' + icon("arrowLeft") + '<span>' + esc(t("detail_back")) + '</span></button></div>' +
        '<div class="detail-body"><div class="detail-block"><div class="detail-block-label">' + esc(t("detail_loading")) + '</div></div></div>';
      this.container.querySelector(".detail-back").addEventListener("click", function() { self.close(); });
    }

    update(sessionId, data) {
      if (this.sessionId !== sessionId || !data) return;
      var self = this;
      var config = STATE_CONFIG[data.state] || STATE_CONFIG.idle;
      var title = data.title || data.basename || (data.agentId || "agent");
      var html = '<div class="detail-header"><button class="detail-back">' + icon("arrowLeft") + '<span>' + esc(t("detail_back")) + '</span></button>';
      html += '<span class="detail-title">' + esc(title) + '</span></div>';
      html += '<div class="detail-body">';

      html += '<div class="detail-block"><div class="detail-block-label">' + esc(data.agentId ? data.agentId.toUpperCase() : "AGENT") + ' &middot; ' + esc(t(config.labelKey)) + '</div>';
      if (data.model) html += '<div class="detail-model">' + esc(data.model) + '</div>';
      html += '</div>';

      if (data.contextUsage) html += this._renderContext(data.contextUsage);

      var events = data.recentEvents || [];
      if (events.length) {
        html += '<div class="detail-block"><div class="detail-block-label">' + esc(t("detail_events")) + '</div><div class="event-timeline">';
        for (var i = 0; i < events.length; i++) {
          var ev = events[i]; var c = STATE_CONFIG[ev.state] || STATE_CONFIG.idle;
          html += '<div class="event-row"><div class="event-dot" style="background:' + c.color + '"></div>';
          html += '<div class="event-line" style="background:' + c.color + '"></div>';
          html += '<span class="event-icon">' + eventIcon(ev.event) + '</span>';
          html += '<span class="event-label">' + esc(eventLabel(ev.event)) + '</span>';
          html += '<span class="event-time">' + formatAgo(ev.at) + '</span></div>';
        }
        html += '</div></div>';
      }

      if (data.lastOutput) {
        html += '<div class="detail-block"><div class="detail-block-label">' + esc(t("detail_output")) + '</div>';
        html += '<div class="detail-output">' + esc(data.lastOutput) + '</div></div>';
      }

      if (data.canFocus) {
        html += '<button class="detail-focus-btn">' + esc(t("detail_focus")) + '</button>';
      }

      html += '</div>';
      this.container.innerHTML = html;
      this.container.querySelector(".detail-back").addEventListener("click", function() { self.close(); });
      var focusBtn = this.container.querySelector(".detail-focus-btn");
      if (focusBtn) focusBtn.addEventListener("click", function() { if (self.onFocus) self.onFocus(self.sessionId); });
    }

    _renderContext(ctx) {
      var html = '<div class="detail-block"><div class="detail-block-label">' + esc(t("detail_context")) + '</div>';
      var pct = (typeof ctx.percent === "number") ? Math.max(0, Math.min(100, ctx.percent)) : null;
      if (pct === null && typeof ctx.used === "number" && typeof ctx.limit === "number" && ctx.limit > 0) {
        pct = Math.max(0, Math.min(100, (ctx.used / ctx.limit) * 100));
      }
      html += '<div class="ctx-bar"><div class="ctx-bar-fill" style="width:' + (pct === null ? 0 : pct) + '%"></div></div>';
      var meta = "";
      if (typeof ctx.used === "number") {
        meta = ctx.used.toLocaleString();
        if (typeof ctx.limit === "number") meta += " / " + ctx.limit.toLocaleString();
      }
      if (pct !== null) meta += (meta ? " &middot; " : "") + Math.round(pct) + "%";
      html += '<div class="ctx-meta">' + (meta || "—") + '</div></div>';
      return html;
    }
  }

  // === PushController ===

  class PushController {
    constructor(connection) { this.connection = connection; this.publicKey = null; }

    supported() {
      return ("serviceWorker" in navigator) && ("PushManager" in window) && ("Notification" in window);
    }

    async _key() {
      if (this.publicKey) return this.publicKey;
      try {
        var res = await fetch("/api/push/vapid-public-key");
        var json = await res.json();
        this.publicKey = json && json.publicKey;
      } catch {}
      return this.publicKey;
    }

    async isSubscribed() {
      if (!this.supported()) return false;
      try {
        var reg = await navigator.serviceWorker.ready;
        var sub = await reg.pushManager.getSubscription();
        return !!sub;
      } catch { return false; }
    }

    async enable() {
      if (!this.supported()) { showToast(t("notif_unsupported"), "error"); return false; }
      var perm = await Notification.requestPermission();
      if (perm !== "granted") { showToast(t("notif_denied"), "error"); return false; }
      var key = await this._key();
      // No key is a server/network problem, not a device-capability one.
      if (!key) { showToast(t("notif_error"), "error"); return false; }
      try {
        var reg = await navigator.serviceWorker.ready;
        var sub = await reg.pushManager.getSubscription();
        if (!sub) {
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(key),
          });
        }
        this.connection.send({ type: "subscribe_push", subscription: sub.toJSON ? sub.toJSON() : sub });
        showToast(t("notif_enabled_toast"), "success");
        return true;
      } catch (err) { log("Push subscribe failed: " + err.message); showToast(t("notif_error"), "error"); return false; }
    }

    async disable() {
      try {
        var reg = await navigator.serviceWorker.ready;
        var sub = await reg.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
      } catch (err) { log("Push unsubscribe failed (server-side removal still applied): " + err.message); }
      // Server-side removal is what actually stops delivery, so report disabled
      // even if the local unsubscribe hiccuped.
      this.connection.send({ type: "subscribe_push", subscription: null });
      showToast(t("notif_disabled_toast"), "info");
      return true;
    }
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var raw = atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  // === App ===

  class App {
    constructor() {
      CLAWD_I18N.init();
      CLAWD_I18N.onChange(() => this._applyLanguage());
      this.connection = new ConnectionManager();
      this.renderer = new SessionRenderer(document.getElementById("session-list"));
      this.settingsRenderer = new SettingsRenderer(document.getElementById("settings-content"));
      this.approvals = new ApprovalRenderer(document.getElementById("approval-list"));
      this.detail = new DetailRenderer(document.getElementById("detail-overlay"));
      this.push = new PushController(this.connection);
      this.notifier = new NotificationManager();
      this.scanner = (typeof window.QrScanner === "function") ? new window.QrScanner() : null;
      this.activeTab = "sessions";
      this._pendingDeepLink = null;

      window._clawdApp = this;

      this._bindNav();
      this._bindConnection();
      this._bindApprovals();
      this._bindDetail();
      this._bindScanner();
      this._bindServiceWorkerMessages();
      this.renderer.startStaleCleanup();

      if ("serviceWorker" in navigator) navigator.serviceWorker.register("/mobile/sw.js").catch(function() {});
      this._readDeepLink();
      this._loadDesktopLanguage();
      this._autoConnect();
    }

    _loadDesktopLanguage() {
      fetch("/api/connection-info").then(function(r) { return r.json(); }).then(function(info) {
        if (info && info.desktopLanguage) CLAWD_I18N.applyDesktopDefault(info.desktopLanguage);
      }).catch(function() {});
    }

    // Re-render every visible surface in the newly chosen language.
    _applyLanguage() {
      var els = document.querySelectorAll("[data-i18n]");
      for (var i = 0; i < els.length; i++) els[i].textContent = t(els[i].getAttribute("data-i18n"));
      this._updateConnectionStatus(this.connection.state);
      this.renderer.render();
      this.approvals.render();
      if (this.activeTab === "settings") this._renderSettings();
      if (this.detail.isOpen()) this.connection.send({ type: "request_detail", sessionId: this.detail.sessionId });
    }

    _bindApprovals() {
      var self = this;
      this.approvals.onDecision = function(handle, decision) {
        self.connection.send({ type: "approval_decision", handle: handle, decision: decision });
      };
    }

    _bindDetail() {
      var self = this;
      this.renderer.onSelect = function(sid) {
        self.detail.open(sid);
        self.connection.send({ type: "request_detail", sessionId: sid });
      };
      this.detail.onFocus = function(sid) {
        self.connection.send({ type: "focus_session", sessionId: sid });
        showToast(t("focus_sent"), "info");
      };
    }

    _bindScanner() {
      var self = this;
      var open = function() { self._openScanner(); };
      this.renderer.onScan = open;
      this.settingsRenderer.onScan = open;
      this._refreshScanCta();
    }

    _openScanner() {
      if (!this.scanner) { showToast(t("scan_camera_denied"), "error"); return; }
      var self = this;
      this.scanner.open(function(text) { self._handleScannedText(text); });
    }

    // A scanned desktop QR carries the live host:port (token-free). Re-point the
    // existing connection at it — a paired device reconnects with its durable
    // credential, no re-pairing and no app reinstall. The /mobile path guard keeps
    // a stray QR from steering the connection (and its credential) somewhere random.
    _handleScannedText(text) {
      var url;
      try { url = new URL(String(text || "").trim()); } catch (e) { showToast(t("scan_unsupported"), "error"); return; }
      if (!/^https?:$/.test(url.protocol) || !url.hostname || !/^\/mobile(\/|$)/.test(url.pathname)) {
        showToast(t("scan_unsupported"), "error");
        return;
      }
      // The durable credential goes out in the WS query, so it must never leave the
      // LAN — only re-point at a local-network host. Defeats a malicious QR that
      // would otherwise exfiltrate the secret to a public server.
      if (!isLanHost(url.hostname)) { showToast(t("scan_not_lan"), "error"); return; }
      var secure = url.protocol === "https:";
      var port = parseInt(url.port, 10) || (secure ? 443 : 80);
      var token = url.searchParams.get("token") || null;
      this.connection.repoint({ host: url.hostname, port: port, secure: secure, token: token });
      // "info", not "success": this only starts the attempt — the header status pill
      // and onOpen report the real connected/failed outcome a moment later.
      showToast(t("scan_repointed", { addr: url.hostname + ":" + port }), "info");
    }

    // The scan affordance is only useful when there's a credential/address to
    // reconnect with and we're not already connected.
    _refreshScanCta() {
      var show = this.connection.state !== "connected"
        && (this.connection.isPaired() || this.connection.getEndpoints().length > 0);
      this.renderer.canScan = show;
      if (this.activeTab === "sessions" && this.renderer.sessions.size === 0) this.renderer.render();
    }

    _bindServiceWorkerMessages() {
      var self = this;
      if (!("serviceWorker" in navigator)) return;
      navigator.serviceWorker.addEventListener("message", function(event) {
        if (event.data && event.data.type === "approval-focus") self._focusApproval(event.data.handle);
      });
    }

    _readDeepLink() {
      var m = (window.location.hash || "").match(/approval=([^&]+)/);
      if (m) { this._pendingDeepLink = decodeURIComponent(m[1]); history.replaceState(null, "", window.location.pathname); }
    }

    _focusApproval(handle) {
      this._switchTab("sessions");
      var el = document.querySelector('#approval-list [data-handle="' + handle + '"]');
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    _locationTarget() {
      if (typeof location === "undefined") return null;
      var host = location.hostname;
      var port = parseInt(location.port, 10);
      if (!host || !port) return null;
      return { host: host, port: port, secure: location.protocol === "https:" };
    }

    // Rebuild the WS target from the desktop's LIVE port (/api/connection-info)
    // before connecting, so a server that moved its port is rediscovered instead of
    // dialing the frozen launch port forever. The host is kept from location (never
    // swapped to info.lanIp) so clawd.local stays clawd.local and the cert SAN matches.
    _resolveTarget() {
      var fallback = this._locationTarget();
      var secure = !!(fallback && fallback.secure);
      // Bound the probe: at a new location the frozen launch origin is unreachable,
      // and a hanging fetch would stall the reconnect rotation for the TCP timeout.
      var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function() { try { ctrl.abort(); } catch (e) {} }, 2500) : null;
      return fetch("/api/connection-info", ctrl ? { signal: ctrl.signal } : undefined)
        .then(function(r) { return r.json(); })
        .then(function(info) {
          if (timer) clearTimeout(timer);
          if (!info || !fallback) return fallback;
          var livePort = secure ? info.httpsPort : info.port;
          if (!livePort) return fallback;
          return { host: fallback.host, port: parseInt(livePort, 10), secure: secure };
        })
        .catch(function() { if (timer) clearTimeout(timer); return fallback; });
    }

    _autoConnect() {
      var params = new URLSearchParams(window.location.search);
      var urlHost = params.get("host");
      var urlPort = params.get("port");
      var urlToken = params.get("token");
      var urlSecure = params.get("secure") === "1" || window.location.protocol === "https:";
      var hasUrl = !!(urlHost && urlPort && urlToken);
      var stored = this.connection.getHistory()[0] || null;

      // A paired device reconnects with its durable credential. The installed app
      // is served by the desktop, so the live `location` is the most reliable WS
      // target — prefer it over possibly-stale stored host/port, then the URL.
      // This is what finally makes the iOS home-screen (standalone) app reconnect:
      // it has no URL token and its own empty storage, but it IS served from the
      // desktop, and the durable credential lives in that same storage.
      if (this.connection.isPaired()) {
        var self = this;
        var fallbackTarget = this._locationTarget() || stored
          || (hasUrl ? { host: urlHost, port: parseInt(urlPort, 10), secure: urlSecure } : null);
        if (fallbackTarget) {
          this._resolveTarget().then(function(target) {
            self.connection.connect(target || fallbackTarget);
          });
          return;
        }
      }

      // A URL token wins only when it points somewhere new (a fresh scan, or a
      // different desktop) so a lingering token can't clobber a rotated one.
      var urlIsNew = hasUrl && (!stored || stored.host !== urlHost || String(stored.port) !== String(urlPort));
      if (stored && stored.token && !urlIsNew) { this.connection.connect(stored); return; }
      if (hasUrl) { this.connection.connect({ host: urlHost, port: parseInt(urlPort, 10), token: urlToken, secure: urlSecure }); return; }
      if (stored && stored.token) { this.connection.connect(stored); return; }

      // No durable credential and no URL token — the installed app's normal
      // first-run state. Surface the code-entry UI instead of sitting dark.
      this.setUnpaired(true);
    }

    setUnpaired(flag) {
      this._needsPairing = !!flag;
      this.renderer.unpaired = !!flag;
      this.renderer.render();
      if (this.activeTab === "settings") this._renderSettings();
    }

    _bindNav() {
      var self = this;
      document.querySelectorAll(".nav-tab").forEach(function(tab) {
        tab.addEventListener("click", function() { self._switchTab(this.getAttribute("data-tab")); });
      });
    }

    _switchTab(tabId) {
      this.activeTab = tabId;
      document.querySelectorAll(".nav-tab").forEach(function(t) {
        t.classList.toggle("active", t.getAttribute("data-tab") === tabId);
      });
      document.getElementById("page-sessions").classList.toggle("hidden", tabId !== "sessions");
      document.getElementById("page-settings").classList.toggle("hidden", tabId !== "settings");
      if (tabId === "settings") {
        this._renderSettings();
      }
    }

    _renderSettings() {
      this.settingsRenderer.render(this.connection, this.push);
    }

    _bindConnection() {
      var self = this;
      this.connection.onStateChange = function(state) {
        self._updateConnectionStatus(state);
        if (state === "connected") self.notifier.requestPermission();
        self._refreshScanCta();
        if (self.activeTab === "settings") self._renderSettings();
      };
      this.connection.onOpen = function() {
        // A paired device may approve once reconnected; a snapshot will refine this.
        self.approvals.setApproveContext(self.connection.isPaired(), self.connection.isSecureConnection());
        if (self.connection.isPaired()) self.setUnpaired(false);
      };
      this.connection.onNeedsPairing = function() { self.setUnpaired(true); };
      this.connection.onCodeError = function() {
        self.settingsRenderer.codeError = t("code_rejected");
        self.setUnpaired(true);
        showToast(t("code_rejected"), "error");
      };
      this.connection.onResolveTarget = function() { return self._resolveTarget(); };
      this.settingsRenderer.onSubmitCode = function(code) {
        self.settingsRenderer.codeError = null;
        self.connection.connectWithCode(code);
      };
      this.settingsRenderer.onDisconnect = function() {
        self.connection.forget();
        self.setUnpaired(true); // already re-renders settings when that tab is active
      };
      this.renderer.onPair = function() { self._switchTab("settings"); };
      this.connection.onMessage = function(msg) {
        if (msg.type === "snapshot") { self.renderer.updateFromSnapshot(msg.sessions || {}); log("Snapshot: " + Object.keys(msg.sessions || {}).length + " sessions"); }
        else if (msg.type === "state") { self.renderer.updateState(msg.sessionId, msg.data); self.notifier.onStateChange(msg.sessionId, msg.data); }
        else if (msg.type === "session_deleted") { self.renderer.removeSession(msg.sessionId); }
        else if (msg.type === "tool_output") { var sid = msg.sessionId; var session = self.renderer.sessions.get(sid); if (session) { session.lastOutput = { toolName: msg.data.toolName, output: (msg.data.output || "").substring(0, 200), at: msg.timestamp || Date.now() }; self.renderer.render(); } }
        else if (msg.type === "token_rotate") {
          var newToken = msg.newToken;
          if (newToken && self.connection.config) {
            self.connection.config.token = newToken;
            self.connection._updateHistoryToken(self.connection.config.host, self.connection.config.port, newToken);
            self.connection.send({ type: "token_rotate_ack" });
            log("Token rotated");
            showToast(t("toast_token_rotated"), "success");
          }
        }
        else if (msg.type === "paired") {
          self.connection.savePairing(msg.deviceId, msg.secret);
          self.settingsRenderer.codeError = null;
          self.approvals.setApproveContext(true, self.connection.isSecureConnection());
          log("Paired as " + msg.deviceId);
          self.setUnpaired(false);
          self._refreshScanCta();
        }
        else if (msg.type === "pair_error") { log("Pair error: " + (msg.message || "")); }
        else if (msg.type === "approval_snapshot") {
          self.approvals.setApproveContext(self.connection.isPaired(), self.connection.isSecureConnection());
          self.approvals.seed(msg.approvals || []);
          if (self._pendingDeepLink) { var h = self._pendingDeepLink; self._pendingDeepLink = null; self._focusApproval(h); }
        }
        else if (msg.type === "approval_request") {
          self.approvals.add({ handle: msg.handle, sessionId: msg.sessionId, title: msg.title, detail: msg.detail, suggestions: msg.suggestions });
        }
        else if (msg.type === "approval_resolved") { self.approvals.resolve(msg.handle, msg.outcome); }
        else if (msg.type === "detail") { self.detail.update(msg.sessionId, msg.data); }
      };
    }

    _updateConnectionStatus(state) {
      var config = CONNECTION_STATES[state] || CONNECTION_STATES.disconnected;
      var dot = document.getElementById("connection-dot");
      var text = document.getElementById("connection-text");
      dot.className = "connection-dot " + config.dot;
      text.textContent = config.textKey ? t(config.textKey) : "";
      text.className = "connection-text" + (state === "connected" ? " connected" : "");
    }

  }

  // === Init ===

  // Lock the viewport scale. Safari ignores user-scalable=no for accessibility, so
  // pinch-zoom is blocked here via its proprietary gesture events; double-tap zoom is
  // handled by touch-action: manipulation in CSS. Scrolling uses touch events, not
  // gesture events, so it's unaffected.
  ["gesturestart", "gesturechange", "gestureend"].forEach(function(evt) {
    document.addEventListener(evt, function(e) { e.preventDefault(); }, { passive: false });
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function() { new App(); });
  else new App();
})();

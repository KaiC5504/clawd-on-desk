"use strict";

(function initSettingsTabDiscordApproval(root) {
  let state = null;
  let helpers = null;
  let ops = null;

  const DISCORD_ID_RE = /^[0-9]{17,20}$/;

  const view = {
    tokenInfo: null,
    tokenInfoSeq: 0,
    tokenInfoLoading: false,
    tokenDraft: "",
    tokenPending: false,
    ownerDraft: null,
    ownerDirty: false,
    channelDraft: null,
    channelDirty: false,
    configPending: false,
    testPending: false,
  };

  function t(key) {
    return helpers.t(key);
  }

  function currentConfig() {
    const cfg = state.snapshot && state.snapshot.discordApproval;
    return {
      enabled: !!(cfg && cfg.enabled),
      ownerUserId: cfg && typeof cfg.ownerUserId === "string" ? cfg.ownerUserId : "",
      fallbackChannelId: cfg && typeof cfg.fallbackChannelId === "string" ? cfg.fallbackChannelId : "",
      notifyOnComplete: !!(cfg && cfg.notifyOnComplete === true),
    };
  }

  function callCommand(action, payload) {
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return Promise.resolve({ status: "error" });
    }
    return window.settingsAPI.command(action, payload).catch((err) => ({
      status: "error",
      message: err && err.message,
    }));
  }

  function refreshTokenInfo({ forceRender = false } = {}) {
    if (view.tokenInfoLoading) return;
    view.tokenInfoLoading = true;
    const seq = ++view.tokenInfoSeq;
    callCommand("discordApproval.tokenInfo").then((result) => {
      if (seq !== view.tokenInfoSeq) return;
      view.tokenInfoLoading = false;
      const previous = view.tokenInfo;
      const updated = result && result.status === "ok";
      const next = updated ? { configured: !!result.configured, masked: result.masked || "" } : previous;
      const changed = updated && tokenInfoKey(previous) !== tokenInfoKey(next);
      if (updated) view.tokenInfo = next;
      if ((forceRender || changed) && state.activeTab === "discord-approval") {
        ops.requestRender({ content: true });
      }
    });
  }

  function tokenInfoKey(info) {
    const i = info && typeof info === "object" ? info : {};
    return [i.configured === true ? "1" : "0", i.masked || ""].join("");
  }

  function ownerDraft() {
    if (view.ownerDraft === null || !view.ownerDirty) view.ownerDraft = currentConfig().ownerUserId;
    return view.ownerDraft;
  }

  function channelDraft() {
    if (view.channelDraft === null || !view.channelDirty) view.channelDraft = currentConfig().fallbackChannelId;
    return view.channelDraft;
  }

  function saveConfig(next) {
    if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return;
    }
    view.configPending = true;
    ops.requestRender({ content: true });
    window.settingsAPI.update("discordApproval", next).then((result) => {
      view.configPending = false;
      if (!result || result.status !== "ok") {
        ops.showToast((result && result.message) || t("toastSaveFailed"), { error: true });
        ops.requestRender({ content: true });
        return;
      }
      ops.showToast(t("discordApprovalConfigSaved"));
      view.ownerDirty = false;
      view.ownerDraft = null;
      view.channelDirty = false;
      view.channelDraft = null;
      ops.requestRender({ content: true });
    }).catch((err) => {
      view.configPending = false;
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      ops.requestRender({ content: true });
    });
  }

  function isConfigured() {
    const cfg = currentConfig();
    const tokenOk = !!(view.tokenInfo && view.tokenInfo.configured);
    return tokenOk && DISCORD_ID_RE.test(cfg.ownerUserId);
  }

  function render(parent) {
    refreshTokenInfo();

    const h1 = document.createElement("h1");
    h1.textContent = t("discordApprovalTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("discordApprovalSubtitle");
    parent.appendChild(subtitle);

    const note = document.createElement("p");
    note.className = "subtitle";
    note.innerHTML = escapeWithLink(t("discordApprovalNoteHtml"));
    parent.appendChild(note);

    parent.appendChild(helpers.buildSection(t("discordApprovalTokenSectionTitle"), [buildTokenRow()]));
    parent.appendChild(helpers.buildSection(t("discordApprovalIdsSectionTitle"), [
      buildOwnerRow(),
      buildChannelRow(),
    ]));
    parent.appendChild(helpers.buildSection(t("discordApprovalActivitySectionTitle"), [
      buildEnabledRow(),
      buildTestRow(),
    ]));
  }

  function buildTokenRow() {
    const configured = !!(view.tokenInfo && view.tokenInfo.configured);
    const masked = (view.tokenInfo && view.tokenInfo.masked) || "";
    const row = document.createElement("div");
    row.className = "row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("discordApprovalTokenLabel");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.innerHTML = escapeWithLink(t("discordApprovalTokenHintHtml"));
    text.appendChild(label);
    text.appendChild(desc);
    if (configured) {
      const status = document.createElement("span");
      status.className = "row-desc";
      status.textContent = `${t("discordApprovalTokenSavedPrefix")} ${masked}`;
      text.appendChild(status);
    }
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const input = document.createElement("input");
    input.type = "password";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.placeholder = configured ? t("discordApprovalReplaceToken") : t("discordApprovalTokenPlaceholder");
    input.className = "tg-approval-input";
    input.value = view.tokenDraft || "";
    input.disabled = view.tokenPending;
    input.addEventListener("input", () => { view.tokenDraft = input.value; });

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "soft-btn accent";
    saveBtn.textContent = view.tokenPending ? t("discordApprovalSaving") : t("discordApprovalSaveToken");
    saveBtn.disabled = view.tokenPending;
    saveBtn.addEventListener("click", () => {
      const token = String(view.tokenDraft || "").trim();
      if (!token) {
        ops.showToast(t("discordApprovalInvalidToken"), { error: true });
        return;
      }
      view.tokenPending = true;
      ops.requestRender({ content: true });
      callCommand("discordApproval.setToken", { token }).then((result) => {
        view.tokenPending = false;
        if (!result || result.status !== "ok") {
          ops.showToast((result && result.message) || t("discordApprovalInvalidToken"), { error: true });
          ops.requestRender({ content: true });
          return;
        }
        view.tokenDraft = "";
        view.tokenInfo = null;
        ops.showToast(t("discordApprovalTokenSaved"));
        refreshTokenInfo({ forceRender: true });
        ops.requestRender({ content: true });
      });
    });

    ctrl.appendChild(input);
    ctrl.appendChild(saveBtn);
    row.appendChild(ctrl);
    return row;
  }

  function buildIdRow({ labelKey, hintKey, placeholderKey, draftValue, onSave, invalidKey, allowEmpty }) {
    const row = document.createElement("div");
    row.className = "row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t(labelKey);
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t(hintKey);
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.spellcheck = false;
    input.placeholder = t(placeholderKey);
    input.className = "tg-approval-input";
    input.value = draftValue.get() || "";
    input.disabled = view.configPending;
    input.addEventListener("input", () => draftValue.set(input.value));

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "soft-btn accent";
    saveBtn.textContent = view.configPending ? t("discordApprovalSaving") : t("discordApprovalSaveIds");
    saveBtn.disabled = view.configPending;
    saveBtn.addEventListener("click", () => {
      const raw = String(draftValue.get() == null ? "" : draftValue.get()).trim();
      if (raw && !DISCORD_ID_RE.test(raw)) {
        ops.showToast(t(invalidKey), { error: true });
        return;
      }
      if (!raw && !allowEmpty) {
        ops.showToast(t(invalidKey), { error: true });
        return;
      }
      onSave(raw);
    });

    ctrl.appendChild(input);
    ctrl.appendChild(saveBtn);
    row.appendChild(ctrl);
    return row;
  }

  function buildOwnerRow() {
    return buildIdRow({
      labelKey: "discordApprovalOwnerLabel",
      hintKey: "discordApprovalOwnerHint",
      placeholderKey: "discordApprovalOwnerPlaceholder",
      invalidKey: "discordApprovalInvalidOwner",
      allowEmpty: false,
      draftValue: { get: ownerDraft, set: (v) => { view.ownerDraft = v; view.ownerDirty = true; } },
      onSave: (raw) => saveConfig({ ...currentConfig(), ownerUserId: raw }),
    });
  }

  function buildChannelRow() {
    return buildIdRow({
      labelKey: "discordApprovalChannelLabel",
      hintKey: "discordApprovalChannelHint",
      placeholderKey: "discordApprovalChannelPlaceholder",
      invalidKey: "discordApprovalInvalidChannel",
      allowEmpty: true,
      draftValue: { get: channelDraft, set: (v) => { view.channelDraft = v; view.channelDirty = true; } },
      onSave: (raw) => saveConfig({ ...currentConfig(), fallbackChannelId: raw }),
    });
  }

  function buildEnabledRow() {
    const cfg = currentConfig();
    const ready = isConfigured();
    const row = document.createElement("div");
    row.className = "row";
    if (!ready) row.classList.add("tg-approval-row-disabled");

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("discordApprovalEnableLabel");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = ready ? t("discordApprovalEnableDesc") : t("discordApprovalEnableNeedsConfig");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const sw = document.createElement("div");
    sw.className = "switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("tabindex", "0");
    helpers.setSwitchVisual(sw, cfg.enabled, { pending: view.configPending });
    if (!ready || view.configPending) {
      sw.classList.add("disabled");
      sw.setAttribute("aria-disabled", "true");
      sw.removeAttribute("tabindex");
    } else {
      const toggle = () => saveConfig({ ...cfg, enabled: !cfg.enabled });
      sw.addEventListener("click", toggle);
      sw.addEventListener("keydown", (ev) => {
        if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); toggle(); }
      });
    }
    ctrl.appendChild(sw);
    row.appendChild(ctrl);
    return row;
  }

  function buildTestRow() {
    const cfg = currentConfig();
    const ready = isConfigured() && cfg.enabled;
    const row = document.createElement("div");
    row.className = "row";
    if (!ready) row.classList.add("tg-approval-row-disabled");

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("discordApprovalTestLabel");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("discordApprovalTestDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "soft-btn";
    btn.textContent = view.testPending ? t("discordApprovalTesting") : t("discordApprovalTestButton");
    btn.disabled = !ready || view.testPending;
    btn.addEventListener("click", () => {
      view.testPending = true;
      ops.requestRender({ content: true });
      callCommand("discordApproval.test").then((result) => {
        view.testPending = false;
        if (!result || result.status !== "ok") {
          ops.showToast((result && result.message) || t("discordApprovalTestFailed"), { error: true });
        } else {
          ops.showToast(t("discordApprovalTestOk"));
        }
        ops.requestRender({ content: true });
      });
    });
    ctrl.appendChild(btn);
    row.appendChild(ctrl);
    return row;
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Whitelists only Discord Developer Portal links, so a malicious translation
  // can't inject arbitrary HTML.
  function escapeWithLink(text) {
    const raw = String(text == null ? "" : text);
    const parts = [];
    let lastIdx = 0;
    const re = /\[([^\]]+)\]\((https:\/\/discord\.com\/developers[A-Za-z0-9_./?#=&-]*)\)/g;
    let match;
    while ((match = re.exec(raw)) !== null) {
      parts.push(escapeHtml(raw.slice(lastIdx, match.index)));
      parts.push(`<a href="${escapeHtml(match[2])}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[1])}</a>`);
      lastIdx = match.index + match[0].length;
    }
    parts.push(escapeHtml(raw.slice(lastIdx)));
    return parts.join("");
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs["discord-approval"] = { render };
  }

  root.ClawdSettingsTabDiscordApproval = { init };
})(globalThis);

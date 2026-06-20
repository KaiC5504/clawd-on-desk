"use strict";

// Unified "Discord" settings tab. One sidebar entry holds both Discord
// sub-features — Rich Presence and Approval — switched by a segmented control
// (same pattern as the Animation Overrides sub-tabs). Each sub-view's rendering
// stays in its own module (settings-tab-discord-presence / -approval); this
// wrapper owns the active sub-tab and delegates the body to it.
(function initSettingsTabDiscord(root) {
  let state = null;
  let helpers = null;
  let ops = null;

  const SUBTABS = ["presence", "approval"];

  function t(key) {
    return helpers.t(key);
  }

  function activeSub() {
    return SUBTABS.includes(state.discordSubtab) ? state.discordSubtab : "presence";
  }

  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("discordTitle");
    parent.appendChild(h1);

    parent.appendChild(buildSubtabSwitcher());

    const body = document.createElement("div");
    body.className = "discord-subview";
    parent.appendChild(body);

    const sub = activeSub();
    const presence = root.ClawdSettingsTabDiscordPresence;
    const approval = root.ClawdSettingsTabDiscordApproval;
    if (sub === "approval" && approval && typeof approval.renderBody === "function") {
      approval.renderBody(body);
    } else if (presence && typeof presence.renderBody === "function") {
      presence.renderBody(body);
    }
  }

  function buildSubtabSwitcher() {
    const wrap = document.createElement("div");
    wrap.className = "discord-subtabs";
    const group = document.createElement("div");
    group.className = "segmented";
    group.setAttribute("role", "tablist");

    const current = activeSub();
    const entries = [
      { key: "presence", label: t("discordSubtabPresence") },
      { key: "approval", label: t("discordSubtabApproval") },
    ];
    for (const entry of entries) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = entry.label;
      btn.setAttribute("role", "tab");
      if (entry.key === current) btn.classList.add("active");
      btn.addEventListener("click", () => {
        if (activeSub() === entry.key) return;
        state.discordSubtab = entry.key;
        ops.requestRender({ content: true });
      });
      group.appendChild(btn);
    }
    wrap.appendChild(group);
    return wrap;
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    if (!SUBTABS.includes(state.discordSubtab)) state.discordSubtab = "presence";
    core.tabs["discord"] = { render };
  }

  root.ClawdSettingsTabDiscord = { init };
})(globalThis);

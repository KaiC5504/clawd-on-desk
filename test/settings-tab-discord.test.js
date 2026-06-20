"use strict";

// Verifies the unified "Discord" settings tab: one tab id ("discord") that holds
// both sub-features behind a segmented switcher, delegating each sub-view's body
// to its own module. Uses a compact fake DOM (no jsdom) — enough for the three
// renderer modules, which only touch createElement/append/classList/attrs/events.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = path.join(__dirname, "..", "src");

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag || "").toUpperCase();
    this.children = [];
    this.className = "";
    this.attributes = {};
    this.listeners = {};
    this.textContent = "";
    this._innerHTML = "";
    this.style = {};
    this.dataset = {};
    const self = this;
    this.classList = {
      add(...names) { self._classSet(names, true); },
      remove(...names) { self._classSet(names, false); },
      toggle(name, force) { self._classSet([name], force === undefined ? !self.classList.contains(name) : !!force); },
      contains(name) { return self._classValues().has(name); },
    };
  }
  _classValues() { return new Set(String(this.className || "").split(/\s+/).filter(Boolean)); }
  _classSet(names, on) {
    const v = this._classValues();
    for (const n of names) { if (on) v.add(n); else v.delete(n); }
    this.className = [...v].join(" ");
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(val) { this._innerHTML = val; if (val === "") this.children = []; }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  removeEventListener() {}
  click() { for (const fn of this.listeners.click || []) fn({}); }
  walk(out = []) { for (const c of this.children) { out.push(c); c.walk(out); } return out; }
  all(sel) {
    const cls = sel.startsWith(".") ? sel.slice(1) : null;
    const tag = cls ? null : sel.toUpperCase();
    return this.walk().filter((e) => (cls ? e.classList.contains(cls) : e.tagName === tag));
  }
  first(sel) { return this.all(sel)[0] || null; }
  texts() { return this.walk().map((e) => e.textContent).filter(Boolean); }
}

function makeContext() {
  const document = { createElement: (tag) => new FakeEl(tag), getElementById: () => null, body: { contains: () => false } };
  const context = {
    console,
    document,
    settingsAPI: {
      discordDefaultAppIdPresent: false,
      command: () => Promise.resolve({ status: "ok", configured: false, masked: "" }),
      update: () => Promise.resolve({ status: "ok" }),
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const f of ["settings-tab-discord-presence.js", "settings-tab-discord-approval.js", "settings-tab-discord.js"]) {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), "utf8"), context);
  }
  return context;
}

function makeCore(context) {
  const renderRequests = [];
  const core = {
    state: {
      activeTab: "discord",
      snapshot: {
        discordPresence: { enabled: false, applicationId: "", privacyShowProject: false },
        discordApproval: { enabled: false, ownerUserId: "", fallbackChannelId: "", notifyOnComplete: false },
      },
    },
    helpers: {
      t: (key) => key,
      buildSection: (title, rows) => {
        const section = context.document.createElement("section");
        if (title) { const h = context.document.createElement("h2"); h.textContent = title; section.appendChild(h); }
        for (const row of rows) section.appendChild(row);
        return section;
      },
      setSwitchVisual: (el, checked, options = {}) => {
        el.classList.toggle("on", !!checked);
        el.setAttribute("aria-checked", checked ? "true" : "false");
        if (options.pending) el.classList.add("pending");
      },
      escapeHtml: (s) => String(s == null ? "" : s),
    },
    ops: {
      requestRender: (payload) => { renderRequests.push(payload || {}); },
      showToast: () => {},
    },
    tabs: {},
  };
  context.ClawdSettingsTabDiscordPresence.init(core);
  context.ClawdSettingsTabDiscordApproval.init(core);
  context.ClawdSettingsTabDiscord.init(core);
  return { core, renderRequests };
}

describe("unified Discord settings tab", () => {
  it("registers a single 'discord' tab and no standalone sub-tabs", () => {
    const ctx = makeContext();
    const { core } = makeCore(ctx);
    assert.equal(typeof core.tabs.discord.render, "function");
    assert.equal(core.tabs["discord-presence"], undefined);
    assert.equal(core.tabs["discord-approval"], undefined);
  });

  it("renders the Discord title + a segmented Rich Presence / Approval switcher", () => {
    const ctx = makeContext();
    const { core } = makeCore(ctx);
    const content = ctx.document.createElement("div");
    core.tabs.discord.render(content, core);

    assert.equal(content.first("h1").textContent, "discordTitle");
    const buttons = content.first(".segmented").all("button");
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0].textContent, "discordSubtabPresence");
    assert.equal(buttons[1].textContent, "discordSubtabApproval");
    // Presence is the default active sub-tab.
    assert.equal(buttons[0].classList.contains("active"), true);
    assert.equal(buttons[1].classList.contains("active"), false);
  });

  it("shows the Rich Presence body by default (App ID row), not approval", () => {
    const ctx = makeContext();
    const { core } = makeCore(ctx);
    const content = ctx.document.createElement("div");
    core.tabs.discord.render(content, core);

    const texts = content.texts();
    assert.ok(texts.includes("discordPresenceAppIdLabel"), "presence App ID row present");
    assert.ok(!texts.includes("discordApprovalTokenLabel"), "approval body not shown yet");
    // No leftover per-sub-view h1 — the wrapper owns the only h1.
    assert.equal(content.all("h1").length, 1);
  });

  it("switches to the Approval body when the Approval segment is clicked", () => {
    const ctx = makeContext();
    const { core, renderRequests } = makeCore(ctx);
    const content = ctx.document.createElement("div");
    core.tabs.discord.render(content, core);

    content.first(".segmented").all("button")[1].click();
    assert.equal(core.state.discordSubtab, "approval");
    assert.ok(renderRequests.some((r) => r.content), "requested a content re-render");

    const content2 = ctx.document.createElement("div");
    core.tabs.discord.render(content2, core);
    const texts = content2.texts();
    assert.ok(texts.includes("discordApprovalTokenLabel"), "approval token row present after switch");
    assert.ok(!texts.includes("discordPresenceAppIdLabel"), "presence body hidden after switch");
    assert.equal(content2.all("h1").length, 1);
  });
});

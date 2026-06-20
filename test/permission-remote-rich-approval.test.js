"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const initPermission = require("../src/permission");

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createMockResponse() {
  const captured = { statusCode: null, headers: {}, body: "", ended: false, destroyCalls: 0, listeners: {} };
  return {
    captured,
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead(status, headers) { captured.statusCode = status; if (headers) Object.assign(captured.headers, headers); this.headersSent = true; },
    end(chunk) { if (chunk !== undefined) captured.body += String(chunk); captured.ended = true; this.writableEnded = true; },
    destroy() { captured.destroyCalls += 1; this.destroyed = true; },
    on(evt, fn) { (captured.listeners[evt] = captured.listeners[evt] || []).push(fn); },
    removeListener(evt, fn) { const l = captured.listeners[evt] || []; const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1); },
  };
}

function makeCtx(overrides = {}) {
  return {
    focusTerminalForSession: () => {},
    getSettingsSnapshot: () => ({}),
    isAgentPermissionsEnabled: () => true,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getPetWindowBounds: () => null,
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    permDebugLog: null,
    repositionUpdateBubble: () => {},
    win: null,
    bubbleFollowPet: false,
    petHidden: false,
    doNotDisturb: false,
    hideBubbles: false,
    sessions: new Map([["sid", { cwd: "D:\\work\\project-alpha" }]]),
    subscribeShortcuts: () => {},
    reportShortcutFailure: () => {},
    clearShortcutFailure: () => {},
    ...overrides,
  };
}

// A telegram-like client that cannot answer rich kinds, and an optional mobile
// client that can. Either may be omitted to model "only one surface connected".
function richCtx({ mobile, telegram, ...rest } = {}) {
  const ctx = makeCtx(rest);
  if (telegram) ctx.getTelegramApprovalClient = () => telegram;
  if (mobile) ctx.getMobileApprovalClient = () => mobile;
  return ctx;
}

function deferredClient(supportsRich) {
  const requests = [];
  let resolveApproval = null;
  const client = {
    isEnabled: () => true,
    requestApproval: (payload, options) => {
      requests.push({ payload, options });
      return new Promise((resolve) => { resolveApproval = resolve; });
    },
  };
  if (supportsRich !== undefined) client.supportsRichInteractions = () => supportsRich;
  return { client, requests, resolve: (d) => resolveApproval && resolveApproval(d) };
}

function makeQuestionEntry(overrides = {}) {
  return {
    res: createMockResponse(),
    abortHandler: () => {},
    suggestions: [],
    sessionId: "sid",
    bubble: null,
    hideTimer: null,
    toolName: "AskUserQuestion",
    isElicitation: true,
    toolInput: {
      questions: [
        { question: "Pick a color", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false },
        { question: "Pick langs", options: [{ label: "JS" }, { label: "Py" }, { label: "Go" }], multiSelect: true },
      ],
    },
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
    agentId: "claude-code",
    ...overrides,
  };
}

function makePlanEntry(overrides = {}) {
  return {
    res: createMockResponse(),
    abortHandler: () => {},
    suggestions: [],
    sessionId: "sid",
    bubble: null,
    hideTimer: null,
    toolName: "ExitPlanMode",
    toolInput: { plan: "Step 1: do the thing\nStep 2: verify it" },
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
    agentId: "claude-code",
    ...overrides,
  };
}

describe("permission remote rich approval (mobile PWA)", () => {
  it("routes a question to the mobile client but never to Telegram", async () => {
    const tg = deferredClient(false);
    const mob = deferredClient(true);
    const perm = initPermission(richCtx({ mobile: mob.client, telegram: tg.client }));
    const entry = makeQuestionEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(tg.requests.length, 0, "Telegram must not receive a question");
    assert.equal(mob.requests.length, 1);
    assert.equal(mob.requests[0].payload.kind, "question");
    assert.equal(mob.requests[0].payload.questions.length, 2);
    assert.equal(mob.requests[0].payload.questions[1].multiSelect, true);
  });

  it("routes a plan to the mobile client but never to Telegram", () => {
    const tg = deferredClient(false);
    const mob = deferredClient(true);
    const perm = initPermission(richCtx({ mobile: mob.client, telegram: tg.client }));
    const entry = makePlanEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(tg.requests.length, 0, "Telegram must not receive a plan");
    assert.equal(mob.requests.length, 1);
    assert.equal(mob.requests[0].payload.kind, "plan");
    assert.match(mob.requests[0].payload.plan, /Step 1/);
  });

  it("does not hang the agent when only Telegram is connected for a question", () => {
    const tg = deferredClient(false);
    const perm = initPermission(richCtx({ telegram: tg.client }));
    const entry = makeQuestionEntry();
    perm.pendingPermissions.push(entry);

    // No rich-capable surface → no remote card, but the entry stays pending so
    // the desktop bubble still owns the resolution. The agent is not answered here.
    assert.equal(perm.maybeStartRemoteApproval(entry), false);
    assert.equal(tg.requests.length, 0);
    assert.notEqual(perm.pendingPermissions.indexOf(entry), -1, "entry still pending; bubble owns it");
    assert.equal(entry.res.captured.ended, false);
  });

  it("applies a single-select question answer as allow + updatedInput.answers", async () => {
    const mob = deferredClient(true);
    const perm = initPermission(richCtx({ mobile: mob.client }));
    const entry = makeQuestionEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    mob.resolve({ action: "elicitation-submit", selections: [{ questionIndex: 0, optionIndices: [1] }] });
    await flush(); await flush();

    assert.equal(perm.pendingPermissions.length, 0);
    const decision = JSON.parse(entry.res.captured.body).hookSpecificOutput.decision;
    assert.equal(decision.behavior, "allow");
    assert.deepEqual(decision.updatedInput.answers, { "Pick a color": "Blue" });
  });

  it("joins multi-select labels with ', ' and substitutes Other free text", async () => {
    const mob = deferredClient(true);
    const perm = initPermission(richCtx({ mobile: mob.client }));
    const entry = makeQuestionEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    mob.resolve({
      action: "elicitation-submit",
      selections: [
        { questionIndex: 0, optionIndices: [], otherText: "Magenta" },
        { questionIndex: 1, optionIndices: [0, 2] },
      ],
    });
    await flush(); await flush();

    const decision = JSON.parse(entry.res.captured.body).hookSpecificOutput.decision;
    assert.deepEqual(decision.updatedInput.answers, { "Pick a color": "Magenta", "Pick langs": "JS, Go" });
  });

  it("denies with the feedback message when a plan gets 'suggest changes'", async () => {
    const mob = deferredClient(true);
    const perm = initPermission(richCtx({ mobile: mob.client }));
    const entry = makePlanEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    mob.resolve({ action: "plan-feedback", feedback: "Add error handling first" });
    await flush(); await flush();

    assert.equal(perm.pendingPermissions.length, 0);
    const decision = JSON.parse(entry.res.captured.body).hookSpecificOutput.decision;
    assert.deepEqual(decision, { behavior: "deny", message: "Add error handling first" });
  });

  it("treats empty plan feedback as go-to-terminal (no allow/deny written)", async () => {
    const mob = deferredClient(true);
    const perm = initPermission(richCtx({ mobile: mob.client }));
    const entry = makePlanEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    mob.resolve({ action: "plan-feedback", feedback: "   " });
    await flush(); await flush();

    assert.equal(perm.pendingPermissions.indexOf(entry), -1, "entry dismissed to terminal");
    assert.equal(entry.res.captured.body, "", "no HTTP allow/deny response written");
  });

  it("approves a plan with a bare allow decision", async () => {
    const mob = deferredClient(true);
    const perm = initPermission(richCtx({ mobile: mob.client }));
    const entry = makePlanEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    mob.resolve("allow");
    await flush(); await flush();

    const decision = JSON.parse(entry.res.captured.body).hookSpecificOutput.decision;
    assert.deepEqual(decision, { behavior: "allow" });
  });

  it("aborts the mobile question request when the desktop resolves first", () => {
    const mob = deferredClient(true);
    const perm = initPermission(richCtx({ mobile: mob.client }));
    const entry = makeQuestionEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    const signal = mob.requests[0].options.signal;
    assert.equal(signal.aborted, false);

    perm.resolvePermissionEntry(entry, "deny");
    assert.equal(signal.aborted, true);
    assert.equal(perm.pendingPermissions.length, 0);
  });

  it("ignores a plan-feedback decision aimed at a non-plan entry", async () => {
    const mob = deferredClient(true);
    const perm = initPermission(richCtx({ mobile: mob.client }));
    const entry = makeQuestionEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    mob.resolve({ action: "plan-feedback", feedback: "nope" });
    await flush(); await flush();

    // Kind mismatch — dropped without consuming the pending approval.
    assert.equal(perm.pendingPermissions.length, 1);
    assert.equal(entry.res.captured.body, "");
  });

  it("does not make a question actionable for a non-rich agent", () => {
    const mob = deferredClient(true);
    const perm = initPermission(richCtx({ mobile: mob.client }));
    const entry = makeQuestionEntry({ agentId: "codex", isCodex: true });
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), false);
    assert.equal(mob.requests.length, 0);
  });
});

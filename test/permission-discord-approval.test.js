"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const initPermission = require("../src/permission");
const { DiscordApprovalClient } = require("../src/discord-approval-client");

const OWNER = "111111111111111111";

// Fake Discord REST: records calls, lets a test force a 50007 ("cannot DM") on
// the DM send and inspect posted cards / edits / interaction callbacks.
function makeFakeRest(opts = {}) {
  const calls = { dmChannels: [], messages: [], edits: [], callbacks: [] };
  let seq = 0;
  return {
    calls,
    createDMChannel(recipientId) {
      calls.dmChannels.push(recipientId);
      return Promise.resolve({ id: `dm-${recipientId}` });
    },
    createMessage(channelId, body) {
      calls.messages.push({ channelId, body });
      if (opts.dmSendError && String(channelId).startsWith("dm-")) {
        const err = new Error("Cannot send messages to this user");
        err.code = opts.dmSendError;
        return Promise.reject(err);
      }
      return Promise.resolve({ id: `msg-${++seq}`, channel_id: channelId });
    },
    editMessage(channelId, messageId, body) {
      calls.edits.push({ channelId, messageId, body });
      return Promise.resolve(null);
    },
    interactionCallback(id, token, payload) {
      calls.callbacks.push({ id, token, payload });
      return Promise.resolve(null);
    },
  };
}

function makeFakeGateway() {
  let handler = null;
  return {
    connected: false,
    onInteraction(fn) { handler = fn; },
    connect() { this.connected = true; },
    close() { this.connected = false; },
    emitInteraction(interaction) { if (handler) handler(interaction); },
  };
}

function makeDiscordClient(opts = {}) {
  const rest = opts.rest || makeFakeRest(opts.restOpts || {});
  const gateway = opts.gateway || makeFakeGateway();
  const client = new DiscordApprovalClient({
    token: "MTAx.Gfake.fakefakefakefakefake",
    ownerUserId: opts.ownerUserId || OWNER,
    fallbackChannelId: opts.fallbackChannelId || "",
    rest,
    gateway,
    log: () => {},
  });
  client.start();
  return { client, rest, gateway };
}

function clickInteraction(customId, userId = OWNER, extra = {}) {
  return {
    type: 3,
    id: "interaction-1",
    token: "interaction-token",
    member: { user: { id: userId } },
    data: { custom_id: customId },
    ...extra,
  };
}

function selectInteraction(customId, values, userId = OWNER) {
  return {
    type: 3,
    id: "select-1",
    token: "select-token",
    member: { user: { id: userId } },
    data: { custom_id: customId, component_type: 3, values },
  };
}

function modalSubmit(customId, text, userId = OWNER) {
  return {
    type: 5,
    id: "modal-1",
    token: "modal-token",
    member: { user: { id: userId } },
    data: { custom_id: customId, components: [{ type: 1, components: [{ type: 4, custom_id: "field", value: text }] }] },
  };
}

function lastCallbackOfType(rest, type) {
  return rest.calls.callbacks.filter((c) => c.payload && c.payload.type === type).slice(-1)[0];
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createMockResponse() {
  const captured = {
    statusCode: null,
    headers: {},
    body: "",
    ended: false,
    destroyCalls: 0,
    listeners: {},
  };
  return {
    captured,
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead(status, headers) {
      captured.statusCode = status;
      if (headers) Object.assign(captured.headers, headers);
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk !== undefined) captured.body += String(chunk);
      captured.ended = true;
      this.writableEnded = true;
    },
    destroy() {
      captured.destroyCalls += 1;
      this.destroyed = true;
    },
    on(evt, fn) {
      (captured.listeners[evt] = captured.listeners[evt] || []).push(fn);
    },
    removeListener(evt, fn) {
      const listeners = captured.listeners[evt] || [];
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    },
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

function makePermEntry(overrides = {}) {
  return {
    res: createMockResponse(),
    abortHandler: () => {},
    suggestions: [],
    sessionId: "sid",
    bubble: null,
    hideTimer: null,
    toolName: "Bash",
    toolInput: {
      command: "npm test -- --token sk-1234567890123456",
      description: "Run project tests",
    },
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
    agentId: "claude-code",
    ...overrides,
  };
}

describe("permission remote-approval registry", () => {
  it("dispatches to the enabled Discord adapter through the registry seam", async () => {
    const requests = [];
    let resolveApproval;
    const discord = {
      isEnabled: () => true,
      requestApproval: (payload, options) => {
        requests.push({ payload, options });
        return new Promise((r) => { resolveApproval = r; });
      },
    };
    const perm = initPermission(makeCtx({
      getRemoteApprovalClients: () => [discord],
    }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(requests.length, 1);

    resolveApproval("allow");
    await flush();
    await flush();

    assert.equal(perm.pendingPermissions.length, 0);
    const body = JSON.parse(entry.res.captured.body);
    assert.deepEqual(body.hookSpecificOutput.decision, { behavior: "allow" });
  });

  it("picks the first enabled adapter and skips disabled ones (priority order)", async () => {
    const calls = [];
    const disabled = {
      isEnabled: () => false,
      requestApproval: () => { calls.push("disabled"); return new Promise(() => {}); },
    };
    let resolveApproval;
    const enabled = {
      isEnabled: () => true,
      requestApproval: () => { calls.push("enabled"); return new Promise((r) => { resolveApproval = r; }); },
    };
    const perm = initPermission(makeCtx({
      getRemoteApprovalClients: () => [disabled, enabled],
    }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.deepEqual(calls, ["enabled"]);

    resolveApproval("deny");
    await flush();
    await flush();
    assert.equal(perm.pendingPermissions.length, 0);
  });

  it("falls back to the single Telegram client when no registry is provided", async () => {
    let resolveApproval;
    const client = {
      isEnabled: () => true,
      requestApproval: () => new Promise((r) => { resolveApproval = r; }),
    };
    const perm = initPermission(makeCtx({ getTelegramApprovalClient: () => client }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    resolveApproval("allow");
    await flush();
    await flush();
    assert.equal(perm.pendingPermissions.length, 0);
  });
});

describe("DiscordApprovalClient adapter", () => {
  it("posts an owner DM with opaque Allow/Deny custom_id (no command/path/session id)", async () => {
    const { client, rest } = makeDiscordClient();
    client.requestApproval({ title: "claude-code requests Bash", detail: "Tool: Bash\nSummary: Run tests" }, {});
    await flush();
    await flush();

    assert.equal(rest.calls.dmChannels[0], OWNER);
    const posted = rest.calls.messages[0];
    assert.ok(posted, "a card was posted");
    const buttons = posted.body.components[0].components;
    const ids = buttons.map((b) => b.custom_id);
    for (const id of ids) {
      assert.match(id, /^(approve|deny):/);
      assert.equal(id.includes("Bash"), false);
      assert.equal(id.includes("/"), false);
      assert.equal(id.includes("sid"), false);
      assert.ok(id.length <= 100);
    }
  });

  it("resolves allow on an owner click after deferring (type 6) within the ACK window", async () => {
    const { client, rest, gateway } = makeDiscordClient();
    const decision = client.requestApproval({ title: "t", detail: "d" }, {});
    await flush();
    await flush();
    const approveId = rest.calls.messages[0].body.components[0].components[0].custom_id;

    gateway.emitInteraction(clickInteraction(approveId));

    assert.equal((await decision), "allow");
    assert.equal(rest.calls.callbacks.length, 1);
    assert.equal(rest.calls.callbacks[0].payload.type, 6); // DEFERRED_UPDATE_MESSAGE
  });

  it("ignores a click from a non-owner user id (owner gating)", async () => {
    const { client, rest, gateway } = makeDiscordClient();
    const decision = client.requestApproval({ title: "t", detail: "d" }, {});
    await flush();
    await flush();
    const approveId = rest.calls.messages[0].body.components[0].components[0].custom_id;

    let resolved = false;
    decision.then(() => { resolved = true; });
    gateway.emitInteraction(clickInteraction(approveId, "999999999999999999"));
    await flush();
    await flush();

    assert.equal(resolved, false, "non-owner click must not resolve");
    assert.equal(rest.calls.callbacks.length, 0, "non-owner click is never ACKed");
  });

  it("falls back to the configured channel when DMs are closed (50007)", async () => {
    const { client, rest } = makeDiscordClient({
      restOpts: { dmSendError: 50007 },
      fallbackChannelId: "222222222222222222",
    });
    client.requestApproval({ title: "t", detail: "d" }, {});
    await flush();
    await flush();

    const channelSends = rest.calls.messages.filter((m) => m.channelId === "222222222222222222");
    assert.equal(channelSends.length, 1, "card posted to the fallback channel");
  });

  it("fails safe (resolves null, never auto-approves) when the card cannot be sent", async () => {
    const { client } = makeDiscordClient({
      restOpts: { dmSendError: 50007 },
      fallbackChannelId: "", // no fallback -> cannot deliver
    });
    const decision = await client.requestApproval({ title: "t", detail: "d" }, {});
    assert.equal(decision, null);
  });

  it("returns null immediately when the abort signal is already aborted", async () => {
    const { client } = makeDiscordClient();
    const controller = new AbortController();
    controller.abort();
    const decision = await client.requestApproval({ title: "t", detail: "d" }, { signal: controller.signal });
    assert.equal(decision, null);
  });

  it("neutralizes the card (drops buttons + appends outcome) when the owner clicks", async () => {
    const { client, rest, gateway } = makeDiscordClient();
    const decision = client.requestApproval({ title: "t", detail: "Summary: do thing" }, {});
    await flush();
    await flush();
    const approveId = rest.calls.messages[0].body.components[0].components[0].custom_id;

    gateway.emitInteraction(clickInteraction(approveId));
    await decision;

    assert.equal(rest.calls.edits.length, 1);
    const edit = rest.calls.edits[0];
    assert.deepEqual(edit.body.components, []);
    assert.match(edit.body.embeds[0].description, /Approved/);
  });

  it("neutralizes the card when another surface resolves first (abort path)", async () => {
    const { client, rest } = makeDiscordClient();
    const controller = new AbortController();
    const decision = client.requestApproval({ title: "t", detail: "d" }, { signal: controller.signal });
    await flush();
    await flush();
    assert.equal(rest.calls.messages.length, 1, "card posted before resolving elsewhere");

    controller.abort();
    assert.equal(await decision, null);

    assert.equal(rest.calls.edits.length, 1);
    assert.deepEqual(rest.calls.edits[0].body.components, []);
    assert.match(rest.calls.edits[0].body.embeds[0].description, /Resolved/);
  });
});

describe("Discord adapter through the permission seam", () => {
  it("aborts the in-flight Discord prompt when another surface resolves first", async () => {
    const { client } = makeDiscordClient();
    const perm = initPermission(makeCtx({ getRemoteApprovalClients: () => [client] }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    const signal = entry.remoteApprovalAbortController.signal;
    assert.equal(signal.aborted, false);

    perm.resolvePermissionEntry(entry, "deny");
    assert.equal(signal.aborted, true);
    assert.equal(perm.pendingPermissions.length, 0);
  });

  it("ignores a late Discord click after the local permission already resolved", async () => {
    const { client, rest, gateway } = makeDiscordClient();
    const perm = initPermission(makeCtx({ getRemoteApprovalClients: () => [client] }));
    const entry = makePermEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    await flush();
    await flush();
    const approveId = rest.calls.messages[0].body.components[0].components[0].custom_id;

    perm.resolvePermissionEntry(entry, "deny");
    const bodyAfterLocal = entry.res.captured.body;

    gateway.emitInteraction(clickInteraction(approveId));
    await flush();
    await flush();

    assert.equal(perm.pendingPermissions.length, 0);
    assert.equal(entry.res.captured.body, bodyAfterLocal);
    assert.deepEqual(JSON.parse(entry.res.captured.body).hookSpecificOutput.decision, { behavior: "deny" });
  });
});

describe("remote elicitation + plan approval over the seam (Discord-only)", () => {
  // A Telegram-shaped client: enabled, but no canHandle -> approval kind only.
  function telegramLike() {
    return { calls: [], isEnabled: () => true, requestApproval(p) { this.calls.push(p); return new Promise(() => {}); } };
  }
  // A Discord-shaped client: declares canHandle for the rich kinds.
  function discordLike(onRequest) {
    return {
      calls: [],
      isEnabled: () => true,
      canHandle: (k) => k === "approval" || k === "question" || k === "plan",
      requestApproval(p) { this.calls.push(p); return onRequest ? onRequest(p) : new Promise(() => {}); },
    };
  }
  function questionEntry(over = {}) {
    return makePermEntry({
      agentId: "claude-code",
      isElicitation: true,
      toolName: "AskUserQuestion",
      toolInput: { questions: [{ question: "Pick one", multiSelect: false, options: [{ label: "Alpha" }, { label: "Bravo" }] }] },
      ...over,
    });
  }
  function planEntry(over = {}) {
    return makePermEntry({
      agentId: "claude-code",
      toolName: "ExitPlanMode",
      toolInput: { plan: "Step 1. Do the thing.\nStep 2. Verify it." },
      ...over,
    });
  }

  it("routes a question only to an adapter that canHandle('question'), with indexed options", () => {
    const tg = telegramLike();
    const dc = discordLike();
    const perm = initPermission(makeCtx({ getRemoteApprovalClients: () => [tg, dc] }));
    const entry = questionEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(tg.calls.length, 0, "telegram (no canHandle) must not receive a question");
    assert.equal(dc.calls.length, 1);
    assert.equal(dc.calls[0].kind, "question");
    assert.equal(dc.calls[0].questions[0].options[1].label, "Bravo");
    assert.equal(dc.calls[0].questions[0].options[1].value, "1");
  });

  it("maps an answer (indices) back to the original question text + labels and resolves allow", async () => {
    let resolveApproval;
    const dc = discordLike(() => new Promise((r) => { resolveApproval = r; }));
    const perm = initPermission(makeCtx({ getRemoteApprovalClients: () => [dc] }));
    const entry = questionEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    resolveApproval({ action: "answer", answers: { 0: { selected: [1] } } });
    await flush();
    await flush();

    assert.equal(perm.pendingPermissions.length, 0);
    const decision = JSON.parse(entry.res.captured.body).hookSpecificOutput.decision;
    assert.equal(decision.behavior, "allow");
    assert.equal(decision.updatedInput.answers["Pick one"], "Bravo");
  });

  it("joins multi-select labels and free-text 'other' into the answer", async () => {
    let resolveApproval;
    const dc = discordLike(() => new Promise((r) => { resolveApproval = r; }));
    const perm = initPermission(makeCtx({ getRemoteApprovalClients: () => [dc] }));
    const entry = questionEntry({ toolInput: { questions: [{ question: "Q", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }] } });
    perm.pendingPermissions.push(entry);

    perm.maybeStartRemoteApproval(entry);
    resolveApproval({ action: "answer", answers: { 0: { selected: [0], other: "custom thing" } } });
    await flush();
    await flush();

    const decision = JSON.parse(entry.res.captured.body).hookSpecificOutput.decision;
    assert.equal(decision.updatedInput.answers["Q"], "A, custom thing");
  });

  it("sends a plan card for ExitPlanMode and approves on allow", async () => {
    let resolveApproval;
    const dc = discordLike(() => new Promise((r) => { resolveApproval = r; }));
    const perm = initPermission(makeCtx({ getRemoteApprovalClients: () => [dc] }));
    const entry = planEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(dc.calls[0].kind, "plan");
    assert.match(dc.calls[0].detail, /Step 1/);

    resolveApproval("allow");
    await flush();
    await flush();
    assert.equal(JSON.parse(entry.res.captured.body).hookSpecificOutput.decision.behavior, "allow");
  });

  it("carries 'keep planning' feedback as a deny message", async () => {
    let resolveApproval;
    const dc = discordLike(() => new Promise((r) => { resolveApproval = r; }));
    const perm = initPermission(makeCtx({ getRemoteApprovalClients: () => [dc] }));
    const entry = planEntry();
    perm.pendingPermissions.push(entry);

    perm.maybeStartRemoteApproval(entry);
    resolveApproval({ action: "deny", message: "Use a different approach" });
    await flush();
    await flush();

    const decision = JSON.parse(entry.res.captured.body).hookSpecificOutput.decision;
    assert.equal(decision.behavior, "deny");
    assert.equal(decision.message, "Use a different approach");
  });

  it("keeps plan/question LOCAL when only a Telegram-style adapter is present", () => {
    const tg = telegramLike();
    const perm = initPermission(makeCtx({ getRemoteApprovalClients: () => [tg] }));
    const entry = questionEntry();
    perm.pendingPermissions.push(entry);

    assert.equal(perm.maybeStartRemoteApproval(entry), false);
    assert.equal(tg.calls.length, 0);
    assert.equal(perm.pendingPermissions.length, 1);
  });

  it("does not make plan/question actionable for non-rich agents", () => {
    const dc = discordLike(() => Promise.resolve(null));
    const perm = initPermission(makeCtx({ getRemoteApprovalClients: () => [dc] }));
    const q = questionEntry({ agentId: "codex", isCodex: true });
    const p = planEntry({ agentId: "codex", isCodex: true });
    perm.pendingPermissions.push(q, p);

    assert.equal(perm.maybeStartRemoteApproval(q), false);
    assert.equal(perm.maybeStartRemoteApproval(p), false);
    assert.equal(dc.calls.length, 0);
  });
});

describe("DiscordApprovalClient — plan + question kinds", () => {
  it("canHandle covers approval/plan/question only", () => {
    const { client } = makeDiscordClient();
    assert.equal(client.canHandle("approval"), true);
    assert.equal(client.canHandle("plan"), true);
    assert.equal(client.canHandle("question"), true);
    assert.equal(client.canHandle("nope"), false);
  });

  it("plan kind posts Approve / Keep planning / Request changes; Approve resolves allow", async () => {
    const { client, rest, gateway } = makeDiscordClient();
    const decision = client.requestApproval({ kind: "plan", title: "Plan", detail: "Step 1. Do X." }, {});
    await flush();
    await flush();
    const ids = rest.calls.messages[0].body.components[0].components.map((b) => b.custom_id);
    assert.match(ids[0], /^approve:/);
    assert.match(ids[1], /^deny:/);
    assert.match(ids[2], /^planmod:/);

    gateway.emitInteraction(clickInteraction(ids[0]));
    assert.equal(await decision, "allow");
  });

  it("plan 'Request changes' opens a modal and submitting resolves deny + feedback", async () => {
    const { client, rest, gateway } = makeDiscordClient();
    const decision = client.requestApproval({ kind: "plan", title: "Plan", detail: "Step 1." }, {});
    await flush();
    await flush();
    const planmodId = rest.calls.messages[0].body.components[0].components[2].custom_id;

    gateway.emitInteraction(clickInteraction(planmodId));
    const modalCb = lastCallbackOfType(rest, 9);
    assert.ok(modalCb, "a modal callback (type 9) was issued");

    gateway.emitInteraction(modalSubmit(modalCb.payload.data.custom_id, "Use approach B instead"));
    assert.deepEqual(await decision, { action: "deny", message: "Use approach B instead" });
  });

  it("single-select question resolves an answer keyed by question index", async () => {
    const { client, rest, gateway } = makeDiscordClient();
    const decision = client.requestApproval({
      kind: "question", title: "Q", detail: "",
      questions: [{ question: "Pick", multiSelect: false, options: [{ value: "0", label: "A" }, { value: "1", label: "B" }] }],
    }, {});
    await flush();
    await flush();
    const optBtns = rest.calls.messages[0].body.components[0].components;
    assert.match(optBtns[1].custom_id, /^qopt:[^:]+:0:1$/);

    gateway.emitInteraction(clickInteraction(optBtns[1].custom_id));
    assert.deepEqual(await decision, { action: "answer", answers: { 0: { selected: [1] } } });
  });

  it("multi-select question uses a select menu + Confirm and resolves all picks", async () => {
    const { client, rest, gateway } = makeDiscordClient();
    const options = [0, 1, 2, 3, 4, 5].map((i) => ({ value: String(i), label: `O${i}` }));
    const decision = client.requestApproval({
      kind: "question", title: "Q", detail: "",
      questions: [{ question: "Pick many", multiSelect: true, options }],
    }, {});
    await flush();
    await flush();
    const rows = rest.calls.messages[0].body.components;
    assert.equal(rows[0].components[0].type, 3, "string select");
    const selId = rows[0].components[0].custom_id;
    const confirmId = rows[1].components[0].custom_id;
    assert.match(confirmId, /^qok:/);

    gateway.emitInteraction(selectInteraction(selId, ["0", "2"]));
    gateway.emitInteraction(clickInteraction(confirmId));
    assert.deepEqual(await decision, { action: "answer", answers: { 0: { selected: [0, 2] } } });
  });

  it("walks multiple questions sequentially then finishes with all answers", async () => {
    const { client, rest, gateway } = makeDiscordClient();
    const decision = client.requestApproval({
      kind: "question", title: "Q", detail: "",
      questions: [
        { question: "Q1", multiSelect: false, options: [{ value: "0", label: "A" }, { value: "1", label: "B" }] },
        { question: "Q2", multiSelect: false, options: [{ value: "0", label: "X" }, { value: "1", label: "Y" }] },
      ],
    }, {});
    await flush();
    await flush();
    const q1 = rest.calls.messages[0].body.components[0].components[0].custom_id; // qopt:h:0:0
    gateway.emitInteraction(clickInteraction(q1));

    const adv = lastCallbackOfType(rest, 7);
    assert.ok(adv, "advanced via UPDATE_MESSAGE");
    const q2btn = adv.payload.data.components[0].components.find((b) => /^qopt:[^:]+:1:1$/.test(b.custom_id));
    assert.ok(q2btn, "second question rendered");
    gateway.emitInteraction(clickInteraction(q2btn.custom_id));

    assert.deepEqual(await decision, { action: "answer", answers: { 0: { selected: [0] }, 1: { selected: [1] } } });
  });

  it("'Other' opens a modal and records free text as the answer", async () => {
    const { client, rest, gateway } = makeDiscordClient();
    const decision = client.requestApproval({
      kind: "question", title: "Q", detail: "",
      questions: [{ question: "Pick", multiSelect: false, options: [{ value: "0", label: "A" }] }],
    }, {});
    await flush();
    await flush();
    const rows = rest.calls.messages[0].body.components;
    const otherId = rows[rows.length - 1].components[0].custom_id;
    assert.match(otherId, /^qother:/);

    gateway.emitInteraction(clickInteraction(otherId));
    const modalCb = lastCallbackOfType(rest, 9);
    assert.ok(modalCb, "Other opens a modal");
    gateway.emitInteraction(modalSubmit(modalCb.payload.data.custom_id, "my own answer"));

    assert.deepEqual(await decision, { action: "answer", answers: { 0: { selected: [], other: "my own answer" } } });
  });

  it("ignores a non-owner click on a question option", async () => {
    const { client, rest, gateway } = makeDiscordClient();
    const decision = client.requestApproval({
      kind: "question", title: "Q", detail: "",
      questions: [{ question: "Pick", multiSelect: false, options: [{ value: "0", label: "A" }] }],
    }, {});
    await flush();
    await flush();
    const optId = rest.calls.messages[0].body.components[0].components[0].custom_id;
    let resolved = false;
    decision.then(() => { resolved = true; });
    gateway.emitInteraction(clickInteraction(optId, "999999999999999999"));
    await flush();
    await flush();
    assert.equal(resolved, false);
  });
});

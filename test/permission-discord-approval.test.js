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

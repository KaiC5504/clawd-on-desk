"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { MobileApprovalClient, isRecognizedDecision } = require("../src/mobile-approval-client");

// In-memory stand-in for the mobile-preview server's WS/push transport. Records
// calls and exposes the registered decision callback so tests can drive a phone
// reply without a real socket.
function makeFakeTransport(opts = {}) {
  const t = {
    approvalsEnabled: opts.approvalsEnabled !== false,
    clients: opts.clients || false,
    pushSub: opts.pushSub || false,
    pushed: [],
    neutralized: [],
    decisionCb: null,
    pushThrows: opts.pushThrows || false,

    isApprovalsEnabled() { return this.approvalsEnabled; },
    hasClients() { return this.clients; },
    hasPushSub() { return this.pushSub; },
    onDecision(cb) { this.decisionCb = cb; },
    pushApproval(handle, payload, sessionId) {
      if (this.pushThrows) throw new Error("transport down");
      this.pushed.push({ handle, payload, sessionId });
    },
    neutralizeApproval(handle, label) {
      this.neutralized.push({ handle, label });
    },
    // Simulate a phone submitting a decision for the most recent approval.
    emitDecision(handle, decision) {
      if (this.decisionCb) this.decisionCb(handle, decision);
    },
    lastHandle() {
      return this.pushed.length ? this.pushed[this.pushed.length - 1].handle : null;
    },
  };
  return t;
}

const PAYLOAD = { title: "Run rm -rf /tmp/scratch", detail: "Tool: Bash" };

describe("isRecognizedDecision", () => {
  it("accepts the string forms allow / deny", () => {
    assert.strictEqual(isRecognizedDecision("allow"), true);
    assert.strictEqual(isRecognizedDecision("deny"), true);
  });

  it("accepts object forms with action/decision allow|deny", () => {
    assert.strictEqual(isRecognizedDecision({ action: "allow" }), true);
    assert.strictEqual(isRecognizedDecision({ decision: "deny" }), true);
  });

  it("accepts a suggestion with an integer index", () => {
    assert.strictEqual(isRecognizedDecision({ action: "suggestion", index: 0 }), true);
    assert.strictEqual(isRecognizedDecision({ action: "suggestion", index: 2 }), true);
  });

  it("rejects junk", () => {
    assert.strictEqual(isRecognizedDecision(undefined), false);
    assert.strictEqual(isRecognizedDecision(null), false);
    assert.strictEqual(isRecognizedDecision("maybe"), false);
    assert.strictEqual(isRecognizedDecision(42), false);
    assert.strictEqual(isRecognizedDecision({}), false);
    assert.strictEqual(isRecognizedDecision({ action: "suggestion" }), false);
    assert.strictEqual(isRecognizedDecision({ action: "suggestion", index: "x" }), false);
    assert.strictEqual(isRecognizedDecision({ action: "wat" }), false);
  });
});

describe("MobileApprovalClient.isEnabled", () => {
  it("is false when there is no transport", () => {
    const client = new MobileApprovalClient({ getTransport: () => null });
    assert.strictEqual(client.isEnabled(), false);
  });

  it("is false when approvals are disabled on the transport", () => {
    const t = makeFakeTransport({ approvalsEnabled: false, clients: true, pushSub: true });
    const client = new MobileApprovalClient({ getTransport: () => t });
    assert.strictEqual(client.isEnabled(), false);
  });

  it("is false when there are no clients and no push subscription", () => {
    const t = makeFakeTransport({ clients: false, pushSub: false });
    const client = new MobileApprovalClient({ getTransport: () => t });
    assert.strictEqual(client.isEnabled(), false);
  });

  it("is true when a client is connected", () => {
    const t = makeFakeTransport({ clients: true, pushSub: false });
    const client = new MobileApprovalClient({ getTransport: () => t });
    assert.strictEqual(client.isEnabled(), true);
  });

  it("is true when only a push subscription exists", () => {
    const t = makeFakeTransport({ clients: false, pushSub: true });
    const client = new MobileApprovalClient({ getTransport: () => t });
    assert.strictEqual(client.isEnabled(), true);
  });
});

describe("MobileApprovalClient.requestApproval", () => {
  it("resolves with the decision when a recognized decision arrives", async () => {
    const t = makeFakeTransport({ clients: true });
    const client = new MobileApprovalClient({ getTransport: () => t, timeoutMs: 5000 });

    const promise = client.requestApproval(PAYLOAD);
    assert.strictEqual(t.pushed.length, 1, "pushApproval should have been called");

    t.emitDecision(t.lastHandle(), "allow");
    const decision = await promise;
    assert.strictEqual(decision, "allow");
  });

  it("resolves with an object suggestion decision", async () => {
    const t = makeFakeTransport({ clients: true });
    const client = new MobileApprovalClient({ getTransport: () => t, timeoutMs: 5000 });

    const promise = client.requestApproval(PAYLOAD);
    const sugg = { action: "suggestion", index: 1 };
    t.emitDecision(t.lastHandle(), sugg);
    assert.deepStrictEqual(await promise, sugg);
  });

  it("calls neutralizeApproval on the transport when an approval finishes", async () => {
    const t = makeFakeTransport({ clients: true });
    const client = new MobileApprovalClient({ getTransport: () => t, timeoutMs: 5000 });

    const promise = client.requestApproval(PAYLOAD);
    const handle = t.lastHandle();
    t.emitDecision(handle, "deny");
    await promise;

    assert.strictEqual(t.neutralized.length, 1);
    assert.strictEqual(t.neutralized[0].handle, handle);
    assert.strictEqual(t.neutralized[0].label, "Denied");
  });

  it("resolves to null on timeout (tiny injected timeoutMs)", async () => {
    const t = makeFakeTransport({ clients: true });
    const client = new MobileApprovalClient({ getTransport: () => t, timeoutMs: 5 });

    const decision = await client.requestApproval(PAYLOAD);
    assert.strictEqual(decision, null);
    // Even a timeout neutralizes the pending approval on the phone.
    assert.strictEqual(t.neutralized.length, 1);
    assert.strictEqual(t.neutralized[0].label, "Handled elsewhere");
  });

  it("resolves to null when the AbortController signal fires", async () => {
    const t = makeFakeTransport({ clients: true });
    // Long timeout so the abort, not the timer, settles the promise.
    const client = new MobileApprovalClient({ getTransport: () => t, timeoutMs: 60000 });

    const ac = new AbortController();
    const promise = client.requestApproval(PAYLOAD, { signal: ac.signal });
    ac.abort();
    assert.strictEqual(await promise, null);
    assert.strictEqual(t.neutralized.length, 1);
  });

  it("resolves to null immediately when the signal is already aborted", async () => {
    const t = makeFakeTransport({ clients: true });
    const client = new MobileApprovalClient({ getTransport: () => t, timeoutMs: 60000 });

    const ac = new AbortController();
    ac.abort();
    const decision = await client.requestApproval(PAYLOAD, { signal: ac.signal });
    assert.strictEqual(decision, null);
    assert.strictEqual(t.pushed.length, 0, "should short-circuit before pushing");
  });

  it("ignores an unrecognized decision (does not resolve the pending approval)", async () => {
    const t = makeFakeTransport({ clients: true });
    const client = new MobileApprovalClient({ getTransport: () => t, timeoutMs: 60000 });

    let settled = false;
    const promise = client.requestApproval(PAYLOAD).then((d) => { settled = true; return d; });
    const handle = t.lastHandle();

    t.emitDecision(handle, "garbage");
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(settled, false, "junk decision must not settle the promise");
    assert.strictEqual(t.neutralized.length, 0, "approval should still be pending");

    // A valid decision afterwards still resolves it.
    t.emitDecision(handle, "allow");
    assert.strictEqual(await promise, "allow");

    client.stop();
  });

  it("resolves to null when there is no transport", async () => {
    const client = new MobileApprovalClient({ getTransport: () => null });
    assert.strictEqual(await client.requestApproval(PAYLOAD), null);
  });

  it("resolves to null when the payload has no title", async () => {
    const t = makeFakeTransport({ clients: true });
    const client = new MobileApprovalClient({ getTransport: () => t });
    assert.strictEqual(await client.requestApproval({ detail: "no title" }), null);
    assert.strictEqual(t.pushed.length, 0);
  });

  it("resolves to null when pushApproval throws", async () => {
    const t = makeFakeTransport({ clients: true, pushThrows: true });
    const client = new MobileApprovalClient({ getTransport: () => t, timeoutMs: 60000 });
    assert.strictEqual(await client.requestApproval(PAYLOAD), null);
  });
});

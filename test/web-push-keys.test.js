"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const webpush = require("web-push");
const { ensureVapid, createPushSender } = require("../src/network/web-push-keys");

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), `clawd-webpush-${crypto.randomBytes(4).toString("hex")}-`));
}

// An obviously-fake subscription shaped like the real Web Push PushSubscription.
function fakeSub(id) {
  return {
    endpoint: `https://push.example.test/${id}`,
    keys: { p256dh: `fake-p256dh-${id}`, auth: `fake-auth-${id}` },
  };
}

describe("ensureVapid", () => {
  let tmpDir;
  let vapidPath;

  before(() => {
    tmpDir = mkTmpDir();
    vapidPath = path.join(tmpDir, "vapid.json");
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("creates vapid.json with public+private key and mailto subject", async () => {
    const keys = await ensureVapid({ filePath: vapidPath });

    assert.strictEqual(typeof keys.publicKey, "string");
    assert.ok(keys.publicKey.length > 0);
    assert.strictEqual(typeof keys.privateKey, "string");
    assert.ok(keys.privateKey.length > 0);
    assert.match(keys.subject, /^mailto:/);
    // Apple returns 403 BadJwtToken if the subject's TLD is reserved/non-routable
    // (e.g. .local) — only a real public domain is accepted.
    assert.doesNotMatch(keys.subject, /\.(local|localhost|internal|invalid|test)$/i);

    assert.ok(fs.existsSync(vapidPath), "vapid.json should be written to disk");
    const onDisk = JSON.parse(fs.readFileSync(vapidPath, "utf8"));
    assert.strictEqual(onDisk.publicKey, keys.publicKey);
    assert.strictEqual(onDisk.privateKey, keys.privateKey);
    assert.match(onDisk.subject, /^mailto:/);
  });

  it("is idempotent: a second call loads the same keys", async () => {
    const first = await ensureVapid({ filePath: vapidPath });
    const second = await ensureVapid({ filePath: vapidPath });

    assert.strictEqual(second.publicKey, first.publicKey);
    assert.strictEqual(second.privateKey, first.privateKey);
    assert.strictEqual(second.subject, first.subject);
  });
});

describe("createPushSender — subscription management", () => {
  let tmpDir;
  let subsPath;
  let vapid;
  let sender;

  before(async () => {
    tmpDir = mkTmpDir();
    subsPath = path.join(tmpDir, "push-subs.json");
    vapid = await ensureVapid({ filePath: path.join(tmpDir, "vapid.json") });
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(() => {
    // Fresh sender + clean subs file per test so state doesn't leak.
    try { fs.rmSync(subsPath, { force: true }); } catch {}
    sender = createPushSender({ vapid, subsPath });
  });

  it("getPublicKey returns the VAPID public key", () => {
    assert.strictEqual(sender.getPublicKey(), vapid.publicKey);
  });

  it("starts with no subscriptions", () => {
    assert.strictEqual(sender.hasSub(), false);
    assert.deepStrictEqual(sender.listDeviceIds(), []);
  });

  it("subscribe registers a device: hasSub()===true and listDeviceIds contains the id", () => {
    sender.subscribe("device-a", fakeSub("a"));

    assert.strictEqual(sender.hasSub(), true);
    assert.deepStrictEqual(sender.listDeviceIds(), ["device-a"]);
  });

  it("subscribe persists to disk and is reloadable by a new sender", () => {
    sender.subscribe("device-a", fakeSub("a"));

    assert.ok(fs.existsSync(subsPath), "push-subs.json should be written");
    const reloaded = createPushSender({ vapid, subsPath });
    assert.strictEqual(reloaded.hasSub(), true);
    assert.deepStrictEqual(reloaded.listDeviceIds(), ["device-a"]);
  });

  it("unsubscribe removes the device", () => {
    sender.subscribe("device-a", fakeSub("a"));
    sender.subscribe("device-b", fakeSub("b"));
    assert.deepStrictEqual(sender.listDeviceIds().sort(), ["device-a", "device-b"]);

    sender.unsubscribe("device-a");
    assert.deepStrictEqual(sender.listDeviceIds(), ["device-b"]);
    assert.strictEqual(sender.hasSub(), true);

    sender.unsubscribe("device-b");
    assert.strictEqual(sender.hasSub(), false);
    assert.deepStrictEqual(sender.listDeviceIds(), []);
  });

  it("unsubscribe of an unknown id is a no-op", () => {
    sender.subscribe("device-a", fakeSub("a"));
    sender.unsubscribe("does-not-exist");
    assert.deepStrictEqual(sender.listDeviceIds(), ["device-a"]);
  });
});

// send() calls webpush.sendNotification, which would hit the network. The module
// references webpush.sendNotification dynamically at call time and web-push is a
// require-cache singleton shared with this test, so we can stub the export to
// avoid real I/O while still exercising send()'s success/prune branches.
describe("createPushSender — send() with stubbed transport", () => {
  let tmpDir;
  let subsPath;
  let vapid;
  let realSendNotification;

  before(async () => {
    tmpDir = mkTmpDir();
    subsPath = path.join(tmpDir, "push-subs.json");
    vapid = await ensureVapid({ filePath: path.join(tmpDir, "vapid.json") });
    realSendNotification = webpush.sendNotification;
  });

  after(() => {
    webpush.sendNotification = realSendNotification;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(() => {
    try { fs.rmSync(subsPath, { force: true }); } catch {}
  });

  it("delivers to every subscription and reports sent count", async () => {
    const calls = [];
    webpush.sendNotification = async (subscription, body, options) => {
      calls.push({ subscription, body, options });
      return { statusCode: 201 };
    };

    const sender = createPushSender({ vapid, subsPath });
    sender.subscribe("device-a", fakeSub("a"));
    sender.subscribe("device-b", fakeSub("b"));

    const result = await sender.send({ title: "hi", body: "there" });

    assert.strictEqual(result.sent, 2);
    assert.strictEqual(result.pruned, 0);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].body, JSON.stringify({ title: "hi", body: "there" }));
    assert.strictEqual(calls[0].options.vapidDetails.publicKey, vapid.publicKey);
    assert.strictEqual(calls[0].options.vapidDetails.subject, vapid.subject);
    // Both subscriptions survive a successful send.
    assert.deepStrictEqual(sender.listDeviceIds().sort(), ["device-a", "device-b"]);
  });

  it("prunes subscriptions on 404/410 and keeps the rest", async () => {
    webpush.sendNotification = async (subscription) => {
      if (subscription.endpoint.endsWith("/gone-410")) {
        const err = new Error("gone");
        err.statusCode = 410;
        throw err;
      }
      if (subscription.endpoint.endsWith("/gone-404")) {
        const err = new Error("not found");
        err.statusCode = 404;
        throw err;
      }
      return { statusCode: 201 };
    };

    const sender = createPushSender({ vapid, subsPath });
    sender.subscribe("ok", fakeSub("ok"));
    sender.subscribe("dead410", fakeSub("gone-410"));
    sender.subscribe("dead404", fakeSub("gone-404"));

    const result = await sender.send({ title: "x" });

    assert.strictEqual(result.sent, 1);
    assert.strictEqual(result.pruned, 2);
    assert.deepStrictEqual(sender.listDeviceIds(), ["ok"]);

    // Pruning is persisted to disk.
    const reloaded = createPushSender({ vapid, subsPath });
    assert.deepStrictEqual(reloaded.listDeviceIds(), ["ok"]);
  });

  it("does not prune on transient (non-404/410) errors", async () => {
    webpush.sendNotification = async () => {
      const err = new Error("server error");
      err.statusCode = 500;
      throw err;
    };

    const sender = createPushSender({ vapid, subsPath });
    sender.subscribe("device-a", fakeSub("a"));

    const result = await sender.send({ title: "x" });

    assert.strictEqual(result.sent, 0);
    assert.strictEqual(result.pruned, 0);
    assert.deepStrictEqual(sender.listDeviceIds(), ["device-a"]);
  });
});

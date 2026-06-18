"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createDeviceRegistry } = require("../src/network/mobile-device-registry");

const HEX64_RE = /^[0-9a-f]{64}$/;
// An obviously-fake secret of the wrong shape, used only for mismatch tests.
const FAKE_SECRET = "deadbeef".repeat(8); // 64 hex chars but won't match a freshly minted one

describe("Mobile Device Registry", () => {
  let tmpDir;
  let storeFile;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `clawd-devreg-${crypto.randomBytes(6).toString("hex")}-`));
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // Fresh file path per test so cases never share roster state.
  beforeEach(() => {
    storeFile = path.join(tmpDir, `devices-${crypto.randomBytes(8).toString("hex")}.json`);
  });

  function newRegistry() {
    return createDeviceRegistry({ filePath: storeFile });
  }

  it("register() issues a 64-hex secret and a public-shaped entry", () => {
    const reg = newRegistry();
    const entry = reg.register({ deviceId: "device-001", label: "My iPhone" });

    assert.strictEqual(entry.deviceId, "device-001");
    assert.strictEqual(entry.label, "My iPhone");
    assert.strictEqual(typeof entry.secret, "string");
    assert.match(entry.secret, HEX64_RE, "secret must be 64 lowercase hex chars (32 bytes)");
    assert.strictEqual(typeof entry.pairedAt, "number");
    assert.strictEqual(typeof entry.lastSeen, "number");
    assert.strictEqual(entry.approvalsAllowed, true);
  });

  it("re-register() rotates the secret but keeps pairedAt", () => {
    const reg = newRegistry();
    const first = reg.register({ deviceId: "device-002", label: "Phone" });
    const second = reg.register({ deviceId: "device-002", label: "Renamed" });

    assert.match(second.secret, HEX64_RE);
    assert.notStrictEqual(second.secret, first.secret, "re-register must mint a new secret");
    assert.strictEqual(second.pairedAt, first.pairedAt, "pairedAt should survive re-registration");
    assert.strictEqual(second.label, "Renamed");

    // The old secret must no longer authenticate.
    assert.strictEqual(reg.authenticate("device-002", first.secret), null);
    assert.ok(reg.authenticate("device-002", second.secret));
  });

  it("authenticate() returns a public entry (no secret) on match", () => {
    const reg = newRegistry();
    const { secret } = reg.register({ deviceId: "device-003", label: "iPad" });

    const pub = reg.authenticate("device-003", secret);
    assert.ok(pub, "matching secret should authenticate");
    assert.strictEqual(pub.deviceId, "device-003");
    assert.strictEqual(pub.label, "iPad");
    assert.strictEqual(pub.approvalsAllowed, true);
    assert.strictEqual(typeof pub.pairedAt, "number");
    assert.strictEqual(typeof pub.lastSeen, "number");
    assert.ok(!("secret" in pub), "authenticate() must never leak the secret field");
  });

  it("authenticate() returns null on a wrong secret and for unknown devices", () => {
    const reg = newRegistry();
    reg.register({ deviceId: "device-004", label: "Phone" });

    assert.strictEqual(reg.authenticate("device-004", FAKE_SECRET), null, "wrong secret rejected");
    assert.strictEqual(reg.authenticate("device-004", "short"), null, "length-mismatched secret rejected");
    assert.strictEqual(reg.authenticate("device-unknown", FAKE_SECRET), null, "unknown device rejected");
    assert.strictEqual(reg.authenticate("device-004", 12345), null, "non-string secret rejected");
  });

  it("revoke() removes a device; revoked secret no longer authenticates", () => {
    const reg = newRegistry();
    const { secret } = reg.register({ deviceId: "device-005", label: "Phone" });
    reg.register({ deviceId: "device-006", label: "Tablet" });

    assert.strictEqual(reg.revoke("device-005"), true);
    assert.strictEqual(reg.revoke("device-005"), false, "revoking twice returns false");
    assert.strictEqual(reg.revoke("never-existed"), false);

    assert.strictEqual(reg.authenticate("device-005", secret), null);
    assert.strictEqual(reg.has("device-005"), false);
    assert.strictEqual(reg.has("device-006"), true);
    assert.strictEqual(reg.size(), 1);
  });

  it("revokeAll() empties the roster", () => {
    const reg = newRegistry();
    reg.register({ deviceId: "device-007", label: "A" });
    reg.register({ deviceId: "device-008", label: "B" });
    assert.strictEqual(reg.size(), 2);

    reg.revokeAll();
    assert.strictEqual(reg.size(), 0);
    assert.deepStrictEqual(reg.list(), []);
  });

  it("list() never includes secrets", () => {
    const reg = newRegistry();
    reg.register({ deviceId: "device-009", label: "One" });
    reg.register({ deviceId: "device-010", label: "Two" });

    const listed = reg.list();
    assert.strictEqual(listed.length, 2);
    for (const e of listed) {
      assert.ok(!("secret" in e), "list() entries must not expose secret");
      assert.strictEqual(typeof e.deviceId, "string");
      assert.strictEqual(typeof e.label, "string");
      assert.strictEqual(typeof e.approvalsAllowed, "boolean");
    }
  });

  it("setApprovalsAllowed() flips the flag and authenticate reflects it", () => {
    const reg = newRegistry();
    const { secret } = reg.register({ deviceId: "device-011", label: "Phone" });
    assert.strictEqual(reg.authenticate("device-011", secret).approvalsAllowed, true);

    assert.strictEqual(reg.setApprovalsAllowed("device-011", false), true);
    assert.strictEqual(reg.authenticate("device-011", secret).approvalsAllowed, false);
    assert.strictEqual(reg.list().find((e) => e.deviceId === "device-011").approvalsAllowed, false);

    assert.strictEqual(reg.setApprovalsAllowed("device-011", true), true);
    assert.strictEqual(reg.authenticate("device-011", secret).approvalsAllowed, true);

    assert.strictEqual(reg.setApprovalsAllowed("never-existed", false), false);
  });

  it("register() rejects deviceIds that fail /^[A-Za-z0-9_-]{8,128}$/", () => {
    const reg = newRegistry();
    const tooShort = "abc123";              // 6 chars
    const tooLong = "a".repeat(129);        // 129 chars
    const badChars = "has spaces!!";        // illegal characters
    const okEdgeLow = "a".repeat(8);        // exactly 8
    const okEdgeHigh = "Z9_-".repeat(32);   // exactly 128, all allowed chars

    // Note: String(undefined)/String(null) ("undefined"/"null") actually PASS the
    // regex, so the registry accepts them — they are not in the rejection set.
    for (const bad of [tooShort, tooLong, badChars, "", "bad id", "tab\tid8"]) {
      assert.throws(() => reg.register({ deviceId: bad, label: "x" }), /Invalid deviceId/);
    }

    // Boundary values are accepted.
    assert.ok(reg.register({ deviceId: okEdgeLow, label: "low" }));
    assert.ok(reg.register({ deviceId: okEdgeHigh, label: "high" }));

    // authenticate() treats invalid ids as a plain miss (no throw).
    assert.strictEqual(reg.authenticate("bad id", FAKE_SECRET), null);
  });

  it("persistence round-trips through the JSON file", () => {
    const regA = newRegistry();
    const { secret } = regA.register({ deviceId: "device-persist", label: "Persisted" });
    regA.setApprovalsAllowed("device-persist", false);

    // The file on disk must hold the device but be readable as JSON.
    const raw = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    assert.strictEqual(raw.version, 1);
    assert.ok(Array.isArray(raw.devices));
    const onDisk = raw.devices.find((d) => d.deviceId === "device-persist");
    assert.ok(onDisk, "device should be persisted to disk");
    assert.strictEqual(onDisk.approvalsAllowed, false);

    // A brand-new registry pointed at the same file recovers the credentials.
    const regB = createDeviceRegistry({ filePath: storeFile });
    assert.strictEqual(regB.has("device-persist"), true);
    assert.strictEqual(regB.size(), 1);

    const pub = regB.authenticate("device-persist", secret);
    assert.ok(pub, "secret minted by regA should authenticate after reload");
    assert.strictEqual(pub.approvalsAllowed, false, "approvalsAllowed should survive reload");
    assert.ok(!("secret" in pub));
  });

  it("a fresh registry on a missing file starts empty without throwing", () => {
    const reg = createDeviceRegistry({
      filePath: path.join(tmpDir, `absent-${crypto.randomBytes(6).toString("hex")}.json`),
    });
    assert.strictEqual(reg.size(), 0);
    assert.deepStrictEqual(reg.list(), []);
  });
});

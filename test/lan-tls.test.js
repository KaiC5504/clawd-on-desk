"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { X509Certificate } = require("node:crypto");
const { ensureTls, getCaCertPem } = require("../src/network/lan-tls");

function freshDir() {
  return path.join(os.tmpdir(), `clawd-tls-test-${crypto.randomBytes(8).toString("hex")}`);
}

function sanStrings(certPem) {
  const cert = new X509Certificate(certPem);
  // subjectAltName is a comma-joined string like "IP Address:1.2.3.4, DNS:clawd.local"
  return (cert.subjectAltName || "").split(",").map((s) => s.trim());
}

describe("lan-tls", () => {
  const dirs = [];
  function makeDir() {
    const d = freshDir();
    dirs.push(d);
    return d;
  }

  after(() => {
    for (const d of dirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it("ensureTls writes ca/leaf files and returns the expected shape", async () => {
    const dir = makeDir();
    const result = await ensureTls({ dir, lanIp: "192.168.1.50" });

    for (const name of ["ca.crt", "ca.key", "leaf.crt", "leaf.key"]) {
      assert.ok(fs.existsSync(path.join(dir, name)), `${name} should be written`);
    }

    assert.strictEqual(typeof result.cert, "string");
    assert.strictEqual(typeof result.key, "string");
    assert.ok(result.ca && typeof result.ca === "object");
    assert.strictEqual(typeof result.ca.certPem, "string");
    assert.strictEqual(typeof result.leafFingerprintSha256, "string");
    assert.strictEqual(result.regenerated, true);
    assert.strictEqual(result.lanIp, "192.168.1.50");
    assert.strictEqual(typeof result.expiresAt, "number");
    assert.ok(result.expiresAt > Date.now());

    // The returned cert/key are the files on disk.
    assert.strictEqual(result.cert, fs.readFileSync(path.join(dir, "leaf.crt"), "utf8"));
    assert.strictEqual(result.ca.certPem, fs.readFileSync(path.join(dir, "ca.crt"), "utf8"));
  });

  it("issues a leaf signed by the CA", async () => {
    const dir = makeDir();
    const result = await ensureTls({ dir, lanIp: "10.0.0.7" });

    const leaf = new X509Certificate(result.cert);
    const ca = new X509Certificate(result.ca.certPem);
    assert.strictEqual(leaf.checkIssued(ca), true);

    // CA fingerprint reported should match the actual CA cert.
    assert.strictEqual(result.ca.fingerprintSha256, ca.fingerprint256);
    // Leaf fingerprint reported should match the actual leaf cert.
    assert.strictEqual(result.leafFingerprintSha256, leaf.fingerprint256);
  });

  it("includes the lanIp and the standard hostnames in the leaf SANs", async () => {
    const dir = makeDir();
    const result = await ensureTls({ dir, lanIp: "172.16.5.4" });
    const sans = sanStrings(result.cert);

    assert.ok(sans.includes("IP Address:172.16.5.4"), `lanIp SAN missing: ${sans.join(" | ")}`);
    assert.ok(sans.includes("IP Address:127.0.0.1"), `loopback SAN missing: ${sans.join(" | ")}`);
    assert.ok(sans.includes("DNS:clawd.local"), `clawd.local SAN missing: ${sans.join(" | ")}`);
    assert.ok(sans.includes("DNS:localhost"), `localhost SAN missing: ${sans.join(" | ")}`);
  });

  it("does not regenerate the leaf when called again with the same lanIp", async () => {
    const dir = makeDir();
    const first = await ensureTls({ dir, lanIp: "192.168.0.20" });
    assert.strictEqual(first.regenerated, true);

    const second = await ensureTls({ dir, lanIp: "192.168.0.20" });
    assert.strictEqual(second.regenerated, false);
    // Same leaf cert content — not re-minted.
    assert.strictEqual(second.cert, first.cert);
    assert.strictEqual(second.leafFingerprintSha256, first.leafFingerprintSha256);
  });

  it("regenerates the leaf when the lanIp changes", async () => {
    const dir = makeDir();
    const first = await ensureTls({ dir, lanIp: "192.168.0.30" });
    assert.strictEqual(first.regenerated, true);

    const second = await ensureTls({ dir, lanIp: "192.168.0.31" });
    assert.strictEqual(second.regenerated, true);
    assert.notStrictEqual(second.leafFingerprintSha256, first.leafFingerprintSha256);

    const sans = sanStrings(second.cert);
    assert.ok(sans.includes("IP Address:192.168.0.31"));
    assert.ok(!sans.includes("IP Address:192.168.0.30"));

    // CA is reused, not regenerated across the IP change.
    assert.strictEqual(second.ca.certPem, first.ca.certPem);
  });

  it("getCaCertPem returns the CA PEM for a provisioned dir", async () => {
    const dir = makeDir();
    const result = await ensureTls({ dir, lanIp: "192.168.9.9" });
    const pem = getCaCertPem({ dir });

    assert.strictEqual(typeof pem, "string");
    assert.strictEqual(pem, result.ca.certPem);
    // Parses as a real cert.
    assert.doesNotThrow(() => new X509Certificate(pem));
  });

  it("getCaCertPem returns null for an empty/missing dir", () => {
    const empty = makeDir(); // never provisioned, dir does not exist
    assert.strictEqual(getCaCertPem({ dir: empty }), null);
  });
});

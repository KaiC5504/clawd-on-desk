// src/network/lan-tls.js — self-signed CA + CA-signed leaf cert manager for LAN HTTPS.
// The CA is generated once and stays put; the leaf is short-lived (~13 months) and
// re-minted whenever the LAN IP changes or it's near expiry, so the user only ever
// has to trust the CA once on their phone.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const selfsigned = require("selfsigned");

const CA_DAYS = 3650;
const LEAF_DAYS = 397;
const RENEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function defaultDir() {
  return path.join(os.homedir(), ".clawd", "tls");
}

function atomicWrite(filePath, data, secret = false) {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, data, secret ? { mode: 0o600 } : undefined);
    fs.renameSync(tmpPath, filePath);
    if (secret) {
      // A failed chmod on a private key is a real security problem (it may be
      // world-readable on POSIX) — surface it instead of swallowing.
      try { fs.chmodSync(filePath, 0o600); }
      catch (err) { console.warn(`[lan-tls] could not restrict ${path.basename(filePath)} to 0600: ${err.message}`); }
    }
    return true;
  } catch (err) {
    console.error(`[lan-tls] write failed for ${path.basename(filePath)}: ${err.message}`);
    return false;
  }
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function sha256Fingerprint(certPem) {
  return new crypto.X509Certificate(certPem).fingerprint256;
}

async function generateCa() {
  const attrs = [
    { name: "commonName", value: "Clawd Local CA" },
    { name: "organizationName", value: "Clawd on Desk" },
  ];
  const options = {
    days: CA_DAYS,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    ],
  };
  return selfsigned.generate(attrs, options);
}

function buildAltNames(lanIp, hostnames) {
  const dnsNames = Array.isArray(hostnames) && hostnames.length
    ? hostnames
    : ["clawd.local", "localhost"];
  const altNames = [{ type: 7, ip: "127.0.0.1" }];
  // lanIp first so it lands in the cert SAN; skip when it would duplicate loopback.
  if (lanIp && lanIp !== "127.0.0.1") altNames.unshift({ type: 7, ip: lanIp });
  for (const name of dnsNames) altNames.push({ type: 2, value: name });
  return altNames;
}

async function generateLeaf(caCertPem, caKeyPem, lanIp, hostnames) {
  const altNames = buildAltNames(lanIp, hostnames);
  const attrs = [{ name: "commonName", value: "clawd.local" }];
  // selfsigned ignores `days` and dates from notAfterDate, so set the date
  // explicitly to keep the cert expiry and our tracked meta.expiresAt in sync.
  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + LEAF_DAYS * DAY_MS);
  const options = {
    days: LEAF_DAYS,
    keySize: 2048,
    algorithm: "sha256",
    notBeforeDate: notBefore,
    notAfterDate: notAfter,
    ca: { cert: caCertPem, key: caKeyPem },
    extensions: [
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames },
    ],
  };
  const pems = await selfsigned.generate(attrs, options);
  return { pems, expiresAt: notAfter.getTime(), sans: altNames };
}

async function ensureTls({ dir, lanIp, hostnames, now } = {}) {
  const baseDir = dir || defaultDir();
  const nowFn = typeof now === "function" ? now : () => Date.now();
  const caCertPath = path.join(baseDir, "ca.crt");
  const caKeyPath = path.join(baseDir, "ca.key");
  const leafCertPath = path.join(baseDir, "leaf.crt");
  const leafKeyPath = path.join(baseDir, "leaf.key");
  const metaPath = path.join(baseDir, "meta.json");

  let caCertPem = readIfExists(caCertPath);
  let caKeyPem = readIfExists(caKeyPath);
  if (caCertPem && caKeyPem) {
    try {
      sha256Fingerprint(caCertPem);
    } catch {
      caCertPem = null;
      caKeyPem = null;
    }
  }
  if (!caCertPem || !caKeyPem) {
    let ca;
    try {
      ca = await generateCa();
    } catch (err) {
      throw new Error(`Failed to generate CA: ${err.message}`);
    }
    caCertPem = ca.cert;
    caKeyPem = ca.private;
    if (!atomicWrite(caCertPath, caCertPem) || !atomicWrite(caKeyPath, caKeyPem, true)) {
      throw new Error("Failed to persist CA certificate/key");
    }
  }

  let meta = null;
  try {
    const raw = readIfExists(metaPath);
    if (raw) meta = JSON.parse(raw);
  } catch {
    meta = null;
  }

  let leafCertPem = readIfExists(leafCertPath);
  let leafKeyPem = readIfExists(leafKeyPath);
  const expiresSoon = !meta || typeof meta.expiresAt !== "number"
    || meta.expiresAt - nowFn() < RENEW_WINDOW_MS;
  const ipChanged = !meta || meta.lanIp !== (lanIp || null);
  const needsMint = !leafCertPem || !leafKeyPem || ipChanged || expiresSoon;

  let expiresAt = meta && typeof meta.expiresAt === "number" ? meta.expiresAt : null;
  let regenerated = false;

  if (needsMint) {
    let minted;
    try {
      minted = await generateLeaf(caCertPem, caKeyPem, lanIp, hostnames);
    } catch (err) {
      throw new Error(`Failed to generate leaf certificate: ${err.message}`);
    }
    leafCertPem = minted.pems.cert;
    leafKeyPem = minted.pems.private;
    expiresAt = minted.expiresAt;
    const nextMeta = { lanIp: lanIp || null, expiresAt, sans: minted.sans };
    if (
      !atomicWrite(leafCertPath, leafCertPem) ||
      !atomicWrite(leafKeyPath, leafKeyPem, true) ||
      !atomicWrite(metaPath, JSON.stringify(nextMeta, null, 2))
    ) {
      throw new Error("Failed to persist leaf certificate/key");
    }
    regenerated = true;
  }

  let leafFingerprintSha256;
  let caFingerprintSha256;
  try {
    leafFingerprintSha256 = sha256Fingerprint(leafCertPem);
    caFingerprintSha256 = sha256Fingerprint(caCertPem);
  } catch (err) {
    throw new Error(`Failed to parse certificate: ${err.message}`);
  }

  return {
    cert: leafCertPem,
    key: leafKeyPem,
    ca: { certPath: caCertPath, certPem: caCertPem, fingerprintSha256: caFingerprintSha256 },
    leafFingerprintSha256,
    regenerated,
    lanIp: lanIp || null,
    expiresAt,
  };
}

function getCaCertPem({ dir } = {}) {
  return readIfExists(path.join(dir || defaultDir(), "ca.crt"));
}

module.exports = { ensureTls, getCaCertPem };

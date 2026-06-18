// src/network/mobile-device-registry.js — durable per-device credential roster ("pair forever").
// Each paired mobile device gets a long-lived secret stored under ~/.clawd/mobile-devices.json.
// Unlike the rotating connection token, these credentials persist until explicitly revoked.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const DEFAULT_PATH = path.join(os.homedir(), ".clawd", "mobile-devices.json");
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const LABEL_MAX = 60;
const SECRET_BYTES = 32;

function mintSecret() {
  return crypto.randomBytes(SECRET_BYTES).toString("hex");
}

function normalizeLabel(label) {
  if (typeof label !== "string") return "iPhone";
  const trimmed = label.trim();
  if (!trimmed) return "iPhone";
  return trimmed.slice(0, LABEL_MAX);
}

function publicEntry(entry) {
  return {
    deviceId: entry.deviceId,
    label: entry.label,
    pairedAt: entry.pairedAt,
    lastSeen: entry.lastSeen,
    approvalsAllowed: entry.approvalsAllowed,
  };
}

function createDeviceRegistry({ filePath, now } = {}) {
  const storePath = filePath || DEFAULT_PATH;
  const clock = typeof now === "function" ? now : () => Date.now();

  let devices = null; // Map<deviceId, entry>; null until first load.

  function load() {
    if (devices) return;
    devices = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
      const list = raw && Array.isArray(raw.devices) ? raw.devices : [];
      for (const d of list) {
        if (!d || !DEVICE_ID_RE.test(d.deviceId) || typeof d.secret !== "string") continue;
        devices.set(d.deviceId, {
          deviceId: d.deviceId,
          label: normalizeLabel(d.label),
          secret: d.secret,
          pairedAt: typeof d.pairedAt === "number" ? d.pairedAt : clock(),
          lastSeen: typeof d.lastSeen === "number" ? d.lastSeen : clock(),
          approvalsAllowed: typeof d.approvalsAllowed === "boolean" ? d.approvalsAllowed : true,
        });
      }
    } catch {
      // Missing or corrupt file — start with an empty roster.
    }
  }

  function persist() {
    try {
      const dir = path.dirname(storePath);
      fs.mkdirSync(dir, { recursive: true });
      const state = { version: 1, devices: Array.from(devices.values()) };
      const tmpPath = storePath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(tmpPath, storePath);
      // chmod after rename in case the final path predated the mode-aware write.
      try { fs.chmodSync(storePath, 0o600); } catch {}
      return true;
    } catch {
      return false;
    }
  }

  function register({ deviceId, label } = {}) {
    load();
    if (!DEVICE_ID_RE.test(deviceId)) throw new Error("Invalid deviceId");
    const ts = clock();
    const existing = devices.get(deviceId);
    const entry = {
      deviceId,
      label: normalizeLabel(label),
      secret: mintSecret(),
      pairedAt: existing ? existing.pairedAt : ts,
      lastSeen: ts,
      approvalsAllowed: existing ? existing.approvalsAllowed : true,
    };
    devices.set(deviceId, entry);
    // If the write fails the secret never reaches disk, so durable auth would
    // break after restart. Roll back and let the caller (pair handler) report it.
    if (!persist()) {
      if (existing) devices.set(deviceId, existing); else devices.delete(deviceId);
      throw new Error("device registry write failed");
    }
    return { ...entry };
  }

  function authenticate(deviceId, secret) {
    load();
    if (!DEVICE_ID_RE.test(deviceId) || typeof secret !== "string") return null;
    const entry = devices.get(deviceId);
    if (!entry) return null;
    const a = Buffer.from(entry.secret, "utf8");
    const b = Buffer.from(secret, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    entry.lastSeen = clock();
    persist();
    return publicEntry(entry);
  }

  function list() {
    load();
    return Array.from(devices.values()).map(publicEntry);
  }

  function get(deviceId) {
    load();
    const entry = devices.get(deviceId);
    return entry ? { ...entry } : null;
  }

  function revoke(deviceId) {
    load();
    if (!devices.delete(deviceId)) return false;
    persist();
    return true;
  }

  function revokeAll() {
    load();
    devices.clear();
    persist();
  }

  function setApprovalsAllowed(deviceId, allowed) {
    load();
    const entry = devices.get(deviceId);
    if (!entry) return false;
    entry.approvalsAllowed = !!allowed;
    persist();
    return true;
  }

  function has(deviceId) {
    load();
    return devices.has(deviceId);
  }

  function size() {
    load();
    return devices.size;
  }

  return {
    register,
    authenticate,
    list,
    get,
    revoke,
    revokeAll,
    setApprovalsAllowed,
    has,
    size,
  };
}

module.exports = { createDeviceRegistry };

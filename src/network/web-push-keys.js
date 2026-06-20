// src/network/web-push-keys.js — VAPID key management + Web Push sender.
// Keys and subscriptions persist under ~/.clawd/. Push delivery uses the
// "web-push" lib; Apple/APNs rejects the VAPID JWT with 403 BadJwtToken unless
// the subject is a mailto:/https: URL on a real public domain — a reserved TLD
// like .local (or https://localhost) is refused.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const webpush = require("web-push");

// web-push requires a mailto: (or https:) contact subject. example.com is the
// RFC 2606 reserved domain: Apple-accepted, never a real person's address, so
// it keeps a personal email out of shipped code.
const VAPID_SUBJECT = "mailto:web-push@example.com";
const DEFAULT_VAPID_PATH = path.join(os.homedir(), ".clawd", "vapid.json");
const DEFAULT_SUBS_PATH = path.join(os.homedir(), ".clawd", "push-subs.json");

function atomicWrite(filePath, data, secret = false) {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = filePath + ".tmp";
    const opts = secret ? { mode: 0o600 } : undefined;
    fs.writeFileSync(tmpPath, data, opts);
    fs.renameSync(tmpPath, filePath);
    if (secret) {
      try { fs.chmodSync(filePath, 0o600); } catch {}
    }
    return true;
  } catch (err) {
    console.error("[web-push] atomicWrite failed:", err.message);
    return false;
  }
}

async function ensureVapid({ filePath } = {}) {
  const vapidPath = filePath || DEFAULT_VAPID_PATH;
  try {
    const raw = JSON.parse(fs.readFileSync(vapidPath, "utf8"));
    if (raw && typeof raw.publicKey === "string" && typeof raw.privateKey === "string") {
      return { publicKey: raw.publicKey, privateKey: raw.privateKey, subject: VAPID_SUBJECT };
    }
  } catch {}

  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  const record = { publicKey, privateKey, subject: VAPID_SUBJECT, createdAt: Date.now() };
  atomicWrite(vapidPath, JSON.stringify(record, null, 2), true);
  return { publicKey, privateKey, subject: VAPID_SUBJECT };
}

function createPushSender({ vapid, subsPath } = {}) {
  const filePath = subsPath || DEFAULT_SUBS_PATH;
  let subs = null; // lazy: { [deviceId]: subscription }

  function load() {
    if (subs) return subs;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      subs = raw && typeof raw === "object" ? raw : {};
    } catch {
      subs = {};
    }
    return subs;
  }

  function persist() {
    atomicWrite(filePath, JSON.stringify(load(), null, 2));
  }

  function getPublicKey() {
    return vapid.publicKey;
  }

  function hasSub() {
    return Object.keys(load()).length > 0;
  }

  function listDeviceIds() {
    return Object.keys(load());
  }

  function subscribe(deviceId, subscription) {
    load()[deviceId] = subscription;
    persist();
  }

  function unsubscribe(deviceId) {
    if (deviceId in load()) {
      delete subs[deviceId];
      persist();
    }
  }

  async function send(payload) {
    const body = JSON.stringify(payload);
    const options = {
      vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      headers: { Urgency: "high", "apns-priority": "10" },
      TTL: 60,
    };

    const entries = Object.entries(load());
    let sent = 0;
    let pruned = 0;

    await Promise.all(entries.map(async ([deviceId, subscription]) => {
      try {
        await webpush.sendNotification(subscription, body, options);
        sent++;
      } catch (err) {
        // 404/410 mean the subscription is gone — drop it so we stop retrying.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          delete subs[deviceId];
          pruned++;
        } else {
          const code = err && err.statusCode != null ? err.statusCode : "?";
          const detail = (err && (err.body || err.message)) || String(err);
          console.warn(`[web-push] send to ${deviceId} failed (status ${code}):`, detail);
        }
      }
    }));

    if (pruned > 0) persist();
    return { sent, pruned };
  }

  return { getPublicKey, hasSub, listDeviceIds, subscribe, unsubscribe, send };
}

module.exports = { ensureVapid, createPushSender };

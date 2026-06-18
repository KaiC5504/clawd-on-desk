// src/network/mdns-advertiser.js — advertise "clawd.local" on the LAN via mDNS
// so phones reach the desktop by hostname across DHCP/IP changes.
// Best-effort: if another mDNS responder owns the port, the advertiser degrades
// to a no-op and the raw-IP fallback URL in the pairing QR still works.

"use strict";

const makeMdns = require("multicast-dns");

const RESPONSE_TTL = 120;

function createMdnsAdvertiser({ hostname = "clawd.local", getIp } = {}) {
  let mdns = null;
  let active = false;
  let warnedRespond = false; // warn once so a broken responder isn't fully silent

  function onQuery(query) {
    if (!active) return;
    for (const q of query.questions) {
      if ((q.type === "A" || q.type === "ANY") && q.name === hostname) {
        let ip;
        try { ip = getIp && getIp(); } catch { ip = null; }
        if (!ip) continue;
        try {
          mdns.respond({ answers: [{ name: hostname, type: "A", ttl: RESPONSE_TTL, data: ip }] });
        } catch (err) {
          if (!warnedRespond) { warnedRespond = true; console.warn(`[mdns] failed to answer ${hostname}: ${err.message}`); }
        }
      }
    }
  }

  function start() {
    if (active) return true;
    try {
      mdns = makeMdns();
    } catch (err) {
      // Port busy (another responder) is the common case — stay a no-op.
      console.warn("[mdns] advertiser disabled:", err.message);
      mdns = null;
      active = false;
      return false;
    }
    active = true;
    mdns.on("query", onQuery);
    return true;
  }

  function stop() {
    if (mdns) { try { mdns.destroy(); } catch {} }
    mdns = null;
    active = false;
  }

  function isActive() {
    return active;
  }

  return { start, stop, isActive };
}

module.exports = { createMdnsAdvertiser };

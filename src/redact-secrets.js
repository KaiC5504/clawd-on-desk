"use strict";

// Best-effort only: secrets split across a chunk boundary, unprefixed opaque
// values, or blobs shorter than the length threshold can pass through undetected.
// This is why HTTPS/loopback is required upstream and why "redacted == safe" is
// never a guarantee.

const PLACEHOLDER = "[redacted]";

// Multiline PEM blocks — applied first so the header/footer lines aren't also
// matched by the long-blob rule.
const RE_PEM = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g;

// Prefixed token shapes whose entire token value is the secret.
const RE_TOKENS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  // JWT: three base64url segments. Must match eyJ to avoid eating normal base64.
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

// Authorization headers carry a scheme word before the credential (e.g.
// `Basic dXNlcjpwYXNz`); a `\S+` value would stop at the space and leak the
// credential. Redact the rest of the line instead. Over-redacting that line is
// intended. `[^\n\r]` keeps it from crossing into the next line.
const RE_AUTHORIZATION = /(authorization)\s*[:=]\s*[^\n\r]+/gi;

// key=value and key: value forms — keep key, redact value.
// The lookahead on the value side is `\S+`; the replacement uses a capture group
// for the key portion.
const RE_KV =
  /(api[_-]?key|secret|token|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*\S+/gi;

// Bearer/Token auth headers — keep the keyword.
const RE_BEARER = /\b(Bearer|Token)\s+[A-Za-z0-9._~+/=:-]{12,}/gi;

// Long opaque blobs (≥40 base64/hex chars). False positives are acceptable —
// the intent is to err on the side of redaction.
const RE_BLOB = /[A-Za-z0-9+/=_-]{40,}/g;

function redactSecrets(text) {
  if (typeof text !== "string") return text;
  if (text === "") return text;

  let out = text;

  // PEM blocks first — they span lines and contain chars the blob rule would hit.
  out = out.replace(RE_PEM, PLACEHOLDER);

  // Prefixed token shapes.
  for (const re of RE_TOKENS) {
    re.lastIndex = 0;
    out = out.replace(re, PLACEHOLDER);
  }

  // Authorization: redact the whole credential (scheme word included).
  out = out.replace(RE_AUTHORIZATION, (match, key) => {
    const sep = match.slice(key.length).match(/\s*[:=]\s*/)[0];
    return `${key}${sep}${PLACEHOLDER}`;
  });

  // Key/value pairs: replace the value portion only.
  // The regex captures the key; we rebuild "key= [redacted]" (preserving the
  // original separator character is not required — the brief only says keep the key).
  out = out.replace(RE_KV, (match, key) => {
    const sep = match.slice(key.length).match(/\s*[:=]\s*/)[0];
    return `${key}${sep}${PLACEHOLDER}`;
  });

  // Bearer / Token headers.
  out = out.replace(RE_BEARER, (_, keyword) => `${keyword} ${PLACEHOLDER}`);

  // Long opaque blobs — last, so earlier passes have already labelled known shapes.
  // Skip matches that are already the placeholder itself.
  out = out.replace(RE_BLOB, (match) =>
    match === PLACEHOLDER ? match : PLACEHOLDER
  );

  return out;
}

module.exports = { redactSecrets, PLACEHOLDER };

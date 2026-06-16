"use strict";

const path = require("path");

// Non-secret config only. The bot token NEVER lives here — it is file-isolated
// at userData/discord-approval.env (see discord-token-store.js). This mirrors
// telegram-approval-settings.js (defaults/normalize/validate/readiness + token
// masking helpers) but without the sidecar/bridge machinery, since the Discord
// adapter runs in-process.

const DEFAULT_DISCORD_APPROVAL = Object.freeze({
  enabled: false,
  ownerUserId: "",        // Discord user id (Developer Mode -> Copy ID)
  fallbackChannelId: "",  // private channel used when DMs are closed (error 50007)
  notifyOnComplete: false,
});

// Discord snowflakes are 17-20 digit decimal ids.
const DISCORD_ID_RE = /^[0-9]{17,20}$/;
// Permissive bot-token shape: `<base64 id>.<base64 ts>[.<hmac>]`. The point is to
// reject empties, whitespace, and obvious non-tokens (anything without a dot) —
// not to enforce Discord's exact internal format, which has changed over time.
const BOT_TOKEN_RE = /^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]{6,})?$/;
const TOKEN_ENV_KEY = "DISCORD_APPROVAL_BOT_TOKEN";
const TOKEN_LINE_RE = /^\s*DISCORD_APPROVAL_BOT_TOKEN\s*=\s*(.+?)\s*$/m;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneDefaultDiscordApproval() {
  return { ...DEFAULT_DISCORD_APPROVAL };
}

function trimString(value, maxLen = 64) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

function isValidDiscordId(value) {
  return DISCORD_ID_RE.test(String(value || "").trim());
}

function normalizeDiscordApproval(value, defaultsValue = DEFAULT_DISCORD_APPROVAL) {
  const defaults = isPlainObject(defaultsValue) ? defaultsValue : DEFAULT_DISCORD_APPROVAL;
  const out = {
    enabled: defaults.enabled === true,
    ownerUserId: isValidDiscordId(defaults.ownerUserId) ? trimString(defaults.ownerUserId, 32) : "",
    fallbackChannelId: isValidDiscordId(defaults.fallbackChannelId) ? trimString(defaults.fallbackChannelId, 32) : "",
    notifyOnComplete: defaults.notifyOnComplete === true,
  };
  if (!isPlainObject(value)) return out;
  if (typeof value.enabled === "boolean") out.enabled = value.enabled;
  if (typeof value.notifyOnComplete === "boolean") out.notifyOnComplete = value.notifyOnComplete;
  if (typeof value.ownerUserId === "string") {
    const candidate = trimString(value.ownerUserId, 32);
    out.ownerUserId = isValidDiscordId(candidate) ? candidate : "";
  }
  if (typeof value.fallbackChannelId === "string") {
    const candidate = trimString(value.fallbackChannelId, 32);
    out.fallbackChannelId = isValidDiscordId(candidate) ? candidate : "";
  }
  return out;
}

function validateDiscordApproval(value) {
  if (!isPlainObject(value)) {
    return { status: "error", message: "discordApproval must be a plain object" };
  }
  for (const key of Object.keys(value)) {
    if (key !== "enabled" && key !== "ownerUserId" && key !== "fallbackChannelId" && key !== "notifyOnComplete") {
      return { status: "error", message: `discordApproval.${key} is not supported` };
    }
  }
  if (typeof value.enabled !== "boolean") {
    return { status: "error", message: "discordApproval.enabled must be a boolean" };
  }
  if (value.notifyOnComplete !== undefined && typeof value.notifyOnComplete !== "boolean") {
    return { status: "error", message: "discordApproval.notifyOnComplete must be a boolean" };
  }
  const owner = trimString(value.ownerUserId, 32);
  if (owner && !isValidDiscordId(owner)) {
    return { status: "error", message: "discordApproval.ownerUserId must be a Discord user id" };
  }
  const channel = trimString(value.fallbackChannelId, 32);
  if (channel && !isValidDiscordId(channel)) {
    return { status: "error", message: "discordApproval.fallbackChannelId must be a Discord channel id" };
  }
  return { status: "ok" };
}

function isValidToken(value) {
  return typeof value === "string" && BOT_TOKEN_RE.test(value.trim());
}

function validateDiscordBotToken(token) {
  const value = typeof token === "string" ? token.trim() : "";
  if (!value) return { status: "error", message: "Discord bot token is required" };
  if (!BOT_TOKEN_RE.test(value)) {
    return { status: "error", message: "Discord bot token format is invalid" };
  }
  return { status: "ok", token: value };
}

function defaultTokenEnvFilePath(userDataDir) {
  return userDataDir ? path.join(userDataDir, "discord-approval.env") : "";
}

function buildTokenEnvFile(token) {
  const validated = validateDiscordBotToken(token);
  if (validated.status !== "ok") return validated;
  return { status: "ok", text: `${TOKEN_ENV_KEY}=${validated.token}\n` };
}

// Atomic temp+rename write (mode 0600 on POSIX). A crash mid-write leaves the
// temp file, never a half-written real token file.
function writeTokenEnvFile({ fs, path: pathModule = path, filePath, token, platform = process.platform } = {}) {
  if (!fs || typeof fs.writeFileSync !== "function") {
    return { status: "error", message: "writeTokenEnvFile requires fs" };
  }
  const built = buildTokenEnvFile(token);
  if (built.status !== "ok") return built;
  if (!filePath || typeof filePath !== "string") {
    return { status: "error", message: "Discord token env file path is required" };
  }
  try {
    const dir = pathModule.dirname(filePath);
    const base = pathModule.basename(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    const tmpPath = pathModule.join(dir, `.${base}.${suffix}.tmp`);
    let fd = null;
    try {
      fd = fs.openSync(tmpPath, "wx", 0o600);
      fs.writeFileSync(fd, built.text, { encoding: "utf8" });
      fs.closeSync(fd);
      fd = null;
      if (platform !== "win32" && typeof fs.chmodSync === "function") {
        fs.chmodSync(tmpPath, 0o600);
      }
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      if (fd != null && typeof fs.closeSync === "function") {
        try { fs.closeSync(fd); } catch {}
      }
      if (typeof fs.rmSync === "function") {
        try { fs.rmSync(tmpPath, { force: true }); } catch {}
      } else if (typeof fs.unlinkSync === "function") {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      throw err;
    }
    if (platform !== "win32" && typeof fs.chmodSync === "function") {
      try { fs.chmodSync(filePath, 0o600); } catch {}
    }
    return { status: "ok", tokenStored: true, filePath };
  } catch (err) {
    return { status: "error", message: `Discord token write failed: ${err && err.message}` };
  }
}

// Short masked preview for UI display only — never the raw token. Discord tokens
// have no public/secret split, so we just show first 4 + last 4 chars.
function maskDiscordBotToken(token) {
  const value = typeof token === "string" ? token.trim() : "";
  if (!value) return "";
  if (value.length < 10) return "••••";
  return `${value.slice(0, 4)}……${value.slice(-4)}`;
}

// Read the token from the env file and return ONLY a masked preview. The raw
// token never leaves main. Returns "" if no token is stored or unreadable.
function readMaskedBotToken({ fs, filePath } = {}) {
  if (!fs || !filePath || typeof fs.readFileSync !== "function") return "";
  let text = "";
  try {
    text = String(fs.readFileSync(filePath, { encoding: "utf8" }) || "");
  } catch {
    return "";
  }
  const match = text.match(TOKEN_LINE_RE);
  if (!match) return "";
  return maskDiscordBotToken(match[1]);
}

function tokenStatus({ fs, filePath } = {}) {
  let fileExists = false;
  let tokenFileMtimeMs = 0;
  if (fs && filePath && typeof fs.existsSync === "function") {
    try { fileExists = fs.existsSync(filePath); } catch { fileExists = false; }
    if (fileExists && typeof fs.statSync === "function") {
      try {
        const stat = fs.statSync(filePath);
        tokenFileMtimeMs = stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
      } catch {
        tokenFileMtimeMs = 0;
      }
    }
  }
  return {
    tokenConfigured: fileExists,
    tokenStored: fileExists,
    tokenFileMtimeMs,
  };
}

function readiness(config, token) {
  const normalized = normalizeDiscordApproval(config);
  if (!normalized.enabled) return { ready: false, reason: "disabled", config: normalized };
  const valid = validateDiscordApproval(normalized);
  if (valid.status !== "ok") return { ready: false, reason: "invalid-config", message: valid.message, config: normalized };
  if (!normalized.ownerUserId) {
    return { ready: false, reason: "invalid-config", message: "Discord owner user id is not configured", config: normalized };
  }
  if (!token || token.tokenConfigured !== true) {
    return { ready: false, reason: "missing-token", message: "Discord bot token is not configured", config: normalized };
  }
  return { ready: true, config: normalized };
}

module.exports = {
  DEFAULT_DISCORD_APPROVAL,
  DISCORD_ID_RE,
  BOT_TOKEN_RE,
  TOKEN_ENV_KEY,
  cloneDefaultDiscordApproval,
  normalizeDiscordApproval,
  validateDiscordApproval,
  validateDiscordBotToken,
  isValidToken,
  isValidDiscordId,
  defaultTokenEnvFilePath,
  buildTokenEnvFile,
  writeTokenEnvFile,
  maskDiscordBotToken,
  readMaskedBotToken,
  tokenStatus,
  readiness,
};

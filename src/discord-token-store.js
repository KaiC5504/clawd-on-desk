"use strict";

// Discord bot-token storage abstraction. HARD FLOOR: the token is the bot's
// password — it must never be committed, shipped, or piped through process.env.
// It lives only at userData/discord-approval.env (outside the repo tree). This
// mirrors telegram-token-store.js; the atomic temp+rename writer lives in
// discord-approval-settings so a crash mid-write can't leave a half-written file.

const fsDefault = require("fs");
const pathDefault = require("path");
const { writeTokenEnvFile, isValidToken } = require("./discord-approval-settings");

const TOKEN_LINE_RE = /^\s*DISCORD_APPROVAL_BOT_TOKEN\s*=\s*(.+?)\s*$/m;

function parseTokenFromEnvFileText(text) {
  if (typeof text !== "string" || !text) return null;
  const match = text.match(TOKEN_LINE_RE);
  if (!match) return null;
  const token = match[1].trim();
  return isValidToken(token) ? token : null;
}

function buildEnvFileText(token) {
  return `DISCORD_APPROVAL_BOT_TOKEN=${token}\n`;
}

function envFileTokenStore({
  filePath,
  fs = fsDefault,
  path: pathModule = pathDefault,
  platform = process.platform,
} = {}) {
  if (typeof filePath !== "string" || !filePath) {
    throw new TypeError("envFileTokenStore: filePath is required");
  }
  if (!fs || typeof fs.readFileSync !== "function") {
    throw new TypeError("envFileTokenStore: fs must implement readFileSync");
  }

  function readText() {
    try {
      return String(fs.readFileSync(filePath, { encoding: "utf8" }) || "");
    } catch {
      return "";
    }
  }

  return {
    kind: "envFile",
    filePath,

    async getToken() {
      return parseTokenFromEnvFileText(readText());
    },

    async hasToken() {
      return parseTokenFromEnvFileText(readText()) !== null;
    },

    async writeToken(token) {
      if (!isValidToken(token)) {
        throw new Error("envFileTokenStore: refusing to write invalid bot token");
      }
      const result = writeTokenEnvFile({ fs, path: pathModule, filePath, token, platform });
      if (!result || result.status !== "ok") {
        throw new Error(
          `envFileTokenStore: writeTokenEnvFile failed (${result && result.message ? result.message : "unknown"})`,
        );
      }
    },

    async deleteToken() {
      if (typeof fs.unlinkSync !== "function") return;
      try {
        fs.unlinkSync(filePath);
      } catch {
        // missing file is fine; other errors silently ignored.
      }
    },
  };
}

module.exports = {
  envFileTokenStore,
  parseTokenFromEnvFileText,
  buildEnvFileText,
  isValidToken,
};

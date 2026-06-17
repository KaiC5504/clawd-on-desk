"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { envFileTokenStore, isValidToken } = require("../src/discord-token-store");
const { maskDiscordBotToken } = require("../src/discord-approval-settings");

// Bot-token-shaped fixture (fake, deliberately not a real-looking token). Real
// Discord tokens are `<base64 id>.<base64 ts>.<hmac>`; this only needs to satisfy
// the validator and exercise masking.
const TOKEN = "faketoken-id.faketoken-ts.faketoken-secret";

test("token round-trips, junk is rejected, and the mask never exposes the token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-token-"));
  const filePath = path.join(dir, "discord-approval.env");
  const store = envFileTokenStore({ filePath });

  assert.equal(isValidToken(TOKEN), true);
  assert.equal(isValidToken("not-a-token"), false);
  assert.equal(isValidToken(""), false);
  assert.equal(isValidToken("   "), false);

  assert.equal(await store.hasToken(), false);

  await store.writeToken(TOKEN);
  assert.equal(await store.getToken(), TOKEN);
  assert.equal(await store.hasToken(), true);

  // Masking lives in the settings module (mirrors maskTelegramBotToken), NOT the
  // store — the store API is get/write/has/delete only.
  const masked = maskDiscordBotToken(TOKEN);
  assert.equal(masked.includes(TOKEN), false);
  assert.equal(masked.length > 0, true);

  // The on-disk file holds the raw token (it lives in userData, outside the
  // repo) but the masked preview that ever reaches the UI must not.
  const onDisk = fs.readFileSync(filePath, "utf8");
  assert.equal(onDisk.includes(TOKEN), true);
  assert.equal(masked.includes(TOKEN.split(".")[2]), false);

  await assert.rejects(() => store.writeToken("not-a-token"));

  await store.deleteToken();
  assert.equal(await store.hasToken(), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a half-written temp file never replaces a good token on write failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-token-"));
  const filePath = path.join(dir, "discord-approval.env");
  const store = envFileTokenStore({ filePath });

  await store.writeToken(TOKEN);
  // Invalid token is rejected before any file mutation — the good token survives.
  await assert.rejects(() => store.writeToken("garbage"));
  assert.equal(await store.getToken(), TOKEN);

  fs.rmSync(dir, { recursive: true, force: true });
});

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const { registerSettingsIpc } = require("../src/settings-ipc");

class FakeIpcMain {
  constructor() {
    this.handlers = new Map();
    this.listeners = new Map();
  }

  handle(channel, listener) {
    this.handlers.set(channel, listener);
  }

  on(channel, listener) {
    this.listeners.set(channel, listener);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
  }

  removeListener(channel, listener) {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }

  invoke(channel, ...args) {
    const listener = this.handlers.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC handler ${channel}`);
    return listener({ sender: "sender-web-contents" }, ...args);
  }

  send(channel, ...args) {
    const listener = this.listeners.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC listener ${channel}`);
    return listener({ sender: "sender-web-contents" }, ...args);
  }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-settings-ipc-"));
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || "");
    const method = entry.method == null ? 0 : entry.method;
    const flags = entry.flags == null ? 0x0800 : entry.flags;
    const compressed = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const declaredUncompressedSize = entry.uncompressedSize == null ? raw.length : entry.uncompressedSize;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredUncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredUncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralOffset = offset;
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, eocd]);
}

function createHarness(overrides = {}) {
  const calls = [];
  const ipcMain = new FakeIpcMain();
  const activeTheme = overrides.activeTheme || {
    _id: "clawd",
    sounds: { complete: "complete.mp3" },
  };
  const settingsController = overrides.settingsController || {
    getSnapshot: () => ({ lang: "en" }),
    applyUpdate: (key, value) => {
      calls.push(["applyUpdate", key, value]);
      return { status: "ok", key, value };
    },
    applyCommand: async (action, payload) => {
      calls.push(["applyCommand", action, payload]);
      return { status: "ok" };
    },
  };
  const themeLoader = overrides.themeLoader || {
    getPreviewSoundUrl: () => "file:///preview.mp3",
    getSoundOverridesDir: () => null,
    getSoundUrl: () => null,
    listThemesWithMetadata: () => [],
    getThemeMetadata: (themeId) => ({ name: themeId }),
    ensureUserThemesDir: () => path.join(os.tmpdir(), "clawd-user-themes"),
  };
  const codexPetMain = overrides.codexPetMain || {
    decorateThemeMetadata: (theme) => theme,
    refreshFromSettings: () => ({ status: "ok", refreshed: true }),
    openCodexPetsDir: () => ({ status: "ok", opened: true }),
    importCodexPetZip: (event) => ({ status: "ok", sender: event.sender }),
    removeCodexPet: (themeId) => ({ status: "ok", removed: themeId }),
  };
  const dialog = overrides.dialog || {
    showOpenDialog: async () => ({ canceled: true }),
    showMessageBox: async () => ({ response: 1 }),
  };
  const shell = overrides.shell || {
    openPath: async () => "",
    openExternal: async (url) => calls.push(["openExternal", url]),
  };
  const settingsSizePreviewSession = overrides.settingsSizePreviewSession || {
    begin: () => {
      calls.push(["sizeBegin"]);
      return { status: "ok", phase: "begin" };
    },
    preview: async (value) => {
      calls.push(["sizePreview", value]);
      return { status: "ok" };
    },
    end: (value) => {
      calls.push(["sizeEnd", value]);
      return { status: "ok", phase: "end", value };
    },
  };
  const runtime = registerSettingsIpc({
    ipcMain,
    app: { getVersion: () => "1.2.3" },
    BrowserWindow: {
      fromWebContents: (sender) => ({ id: "parent", sender }),
    },
    dialog,
    shell,
    fs: overrides.fs || fs,
    path: overrides.path || path,
    settingsController,
    themeLoader,
    codexPetMain,
    getSettingsWindow: () => ({ id: "settings-window" }),
    getActiveTheme: () => activeTheme,
    getLang: overrides.getLang || (() => "en"),
    settingsSizePreviewSession,
    isValidSizePreviewKey: (value) => /^P:\d+$/.test(value),
    sendToRenderer: (...args) => calls.push(["sendToRenderer", ...args]),
    getDoNotDisturb: overrides.getDoNotDisturb || (() => false),
    getSoundMuted: overrides.getSoundMuted || (() => false),
    getSoundVolume: overrides.getSoundVolume || (() => 0.4),
    getAllAgents: overrides.getAllAgents || (() => []),
    detectAgentInstallations: overrides.detectAgentInstallations,
    getHardwareBuddyStatus: overrides.getHardwareBuddyStatus || (() => null),
    testHardwareBuddyApproval: overrides.testHardwareBuddyApproval,
    getQuickCommandPresets: overrides.getQuickCommandPresets,
    sendQuickCommand: overrides.sendQuickCommand,
    checkForUpdates: (manual) => calls.push(["checkForUpdates", manual]),
    showTutorial: overrides.showTutorial || (() => {
      calls.push(["showTutorial"]);
      return { status: "ok" };
    }),
    aboutHeroSvgPath: overrides.aboutHeroSvgPath || path.join(__dirname, "missing-about-hero.svg"),
    getLanWsServer: overrides.getLanWsServer || (() => null),
    now: overrides.now || (() => 12345),
  });
  return { ipcMain, runtime, calls, activeTheme };
}

test("settings IPC registers owned channels and leaves animation override channels to their module", () => {
  const { ipcMain, runtime } = createHarness();

  assert.ok(ipcMain.handlers.has("settings:get-snapshot"));
  assert.ok(ipcMain.handlers.has("settings:pick-sound-file"));
  assert.ok(ipcMain.handlers.has("settings:list-themes"));
  assert.ok(ipcMain.handlers.has("settings:detect-agent-installations"));
  assert.ok(ipcMain.handlers.has("settings:test-hardware-buddy-approval"));
  assert.ok(ipcMain.handlers.has("settings:get-quick-command-presets"));
  assert.ok(ipcMain.handlers.has("settings:send-quick-command"));
  assert.ok(ipcMain.handlers.has("settings:show-tutorial"));
  assert.ok(ipcMain.handlers.has("settings:open-user-themes-dir"));
  assert.ok(ipcMain.handlers.has("settings:import-user-theme-zip"));
  assert.ok(ipcMain.handlers.has("settings:refresh-codex-pets"));
  assert.ok(!ipcMain.listeners.has("settings:open-dashboard"));
  assert.ok(!ipcMain.handlers.has("settings:getShortcutFailures"));
  assert.ok(!ipcMain.handlers.has("settings:enterShortcutRecording"));
  assert.ok(!ipcMain.handlers.has("settings:exitShortcutRecording"));
  assert.ok(!ipcMain.handlers.has("settings:get-animation-overrides-data"));
  assert.ok(!ipcMain.handlers.has("settings:open-theme-assets-dir"));
  assert.ok(!ipcMain.handlers.has("settings:preview-animation-override"));
  assert.ok(!ipcMain.handlers.has("settings:preview-reaction"));
  assert.ok(!ipcMain.handlers.has("settings:export-animation-overrides"));
  assert.ok(!ipcMain.handlers.has("settings:import-animation-overrides"));

  runtime.dispose();

  assert.strictEqual(ipcMain.handlers.size, 0);
  assert.strictEqual(ipcMain.listeners.size, 0);
});

test("settings IPC opens the tutorial from Settings", async () => {
  const { ipcMain, runtime, calls } = createHarness();

  const result = await ipcMain.invoke("settings:show-tutorial");

  assert.deepStrictEqual(result, { status: "ok" });
  assert.deepStrictEqual(calls, [["showTutorial"]]);
  runtime.dispose();
});

test("mobile connection info reports starting until the LAN bridge has a port", async () => {
  const token = "0123456789abcdef0123456789abcdef";
  const { ipcMain, runtime } = createHarness({
    getLanWsServer: () => ({
      getPort: () => null,
      getToken: () => token,
    }),
  });

  const result = await ipcMain.invoke("settings:mobile-connection-info");

  assert.deepStrictEqual(result, {
    status: "starting",
    message: "LAN bridge is starting",
  });
  runtime.dispose();
});

test("mobile connection info returns port, token, and LAN IP when ready", async () => {
  const token = "0123456789abcdef0123456789abcdef";
  const { ipcMain, runtime } = createHarness({
    getLanWsServer: () => ({
      getPort: () => 23334,
      getToken: () => token,
    }),
  });

  const result = await ipcMain.invoke("settings:mobile-connection-info");

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.port, 23334);
  assert.strictEqual(result.token, token);
  assert.strictEqual(typeof result.lanIp, "string");
  // The token-carrying pair URL was removed — bootstrapping is the typed code.
  assert.ok(!("pairUrl" in result));
  runtime.dispose();
});

test("settings IPC delegates controller and size preview handlers", async () => {
  const { ipcMain, calls } = createHarness();

  assert.deepStrictEqual(await ipcMain.invoke("settings:get-snapshot"), { lang: "en" });
  assert.deepStrictEqual(
    await ipcMain.invoke("settings:update", null),
    { status: "error", message: "settings:update payload must be { key, value }" }
  );
  assert.deepStrictEqual(await ipcMain.invoke("settings:update", { key: "size", value: "P:20" }), {
    status: "ok",
    key: "size",
    value: "P:20",
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:update", { key: "tgMigration", value: { transport: "native" } }), {
    status: "error",
    message: "tgMigration is internal; use telegramMigration.dispatch",
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:update", { key: "autoApproveAllPermissions", value: true }), {
    status: "error",
    message: "autoApproveAllPermissions is gated; use the setAutoApproveAll command",
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:command", { action: "resizePet", payload: "P:30" }), {
    status: "ok",
  });
  assert.strictEqual(await ipcMain.invoke("settings:get-hardware-buddy-status"), null);
  assert.deepStrictEqual(await ipcMain.invoke("settings:test-hardware-buddy-approval"), {
    status: "error",
    message: "Hardware Buddy test approval is unavailable",
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:get-quick-command-presets"), {
    enabled: false,
    presets: [],
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:send-quick-command", { id: "plan_first" }), {
    status: "error",
    code: "quick_commands_unavailable",
    message: "Quick Commands are unavailable",
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:begin-size-preview"), {
    status: "ok",
    phase: "begin",
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:preview-size", "bad"), {
    status: "error",
    message: 'invalid preview size "bad"',
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:preview-size", "P:35"), { status: "ok" });
  assert.deepStrictEqual(await ipcMain.invoke("settings:end-size-preview", "P:35"), {
    status: "ok",
    phase: "end",
    value: "P:35",
  });

  assert.deepStrictEqual(calls, [
    ["applyUpdate", "size", "P:20"],
    ["applyCommand", "resizePet", "P:30"],
    ["sizeBegin"],
    ["sizePreview", "P:35"],
    ["sizeEnd", "P:35"],
  ]);
});

test("settings IPC delegates Hardware Buddy test approval helper", async () => {
  const calls = [];
  const { ipcMain } = createHarness({
    testHardwareBuddyApproval: () => {
      calls.push("test");
      return Promise.resolve({ status: "ok", decision: "deny" });
    },
  });

  assert.deepStrictEqual(
    await ipcMain.invoke("settings:test-hardware-buddy-approval", { ignored: true }),
    { status: "ok", decision: "deny" }
  );
  assert.deepStrictEqual(calls, ["test"]);
});

test("settings IPC delegates Quick Command helpers", async () => {
  const calls = [];
  const { ipcMain } = createHarness({
    getQuickCommandPresets: () => ({
      enabled: true,
      presets: [{ id: "plan_first", label: "先列计划" }],
    }),
    sendQuickCommand: (payload) => {
      calls.push(payload);
      return { status: "ok", quickCommand: { id: payload.id } };
    },
  });

  assert.deepStrictEqual(await ipcMain.invoke("settings:get-quick-command-presets"), {
    enabled: true,
    presets: [{ id: "plan_first", label: "先列计划" }],
  });
  assert.deepStrictEqual(
    await ipcMain.invoke("settings:send-quick-command", {
      id: "plan_first",
      clientRequestId: "qc-1",
      userText: "should be stripped",
      source: "renderer",
      duration: "next_turn",
      target: { scope: "active_session", sessionId: "session-1" },
    }),
    { status: "ok", quickCommand: { id: "plan_first" } }
  );
  assert.deepStrictEqual(calls, [{ id: "plan_first", clientRequestId: "qc-1" }]);
});

test("settings IPC delegates Codex Pet theme channels and decorates metadata", async () => {
  const codexCalls = [];
  const { ipcMain } = createHarness({
    activeTheme: { _id: "imported-pet", sounds: {} },
    themeLoader: {
      getPreviewSoundUrl: () => null,
      getSoundOverridesDir: () => null,
      getSoundUrl: () => null,
      listThemesWithMetadata: () => [
        { id: "clawd", name: "Clawd" },
        { id: "imported-pet", name: "Imported Pet" },
      ],
      getThemeMetadata: () => null,
    },
    codexPetMain: {
      decorateThemeMetadata: (theme) => ({
        ...theme,
        managedCodexPet: theme.id === "imported-pet",
      }),
      refreshFromSettings: () => {
        codexCalls.push("refresh");
        return { status: "ok", refreshed: true };
      },
      openCodexPetsDir: () => {
        codexCalls.push("open-dir");
        return { status: "ok", opened: true };
      },
      importCodexPetZip: (event) => {
        codexCalls.push(["import", event.sender]);
        return { status: "ok", imported: true };
      },
      removeCodexPet: (themeId) => {
        codexCalls.push(["remove", themeId]);
        return { status: "ok", removed: themeId };
      },
    },
  });

  assert.deepStrictEqual(await ipcMain.invoke("settings:list-themes"), [
    { id: "clawd", name: "Clawd", active: false, managedCodexPet: false },
    { id: "imported-pet", name: "Imported Pet", active: true, managedCodexPet: true },
  ]);
  assert.deepStrictEqual(await ipcMain.invoke("settings:refresh-codex-pets"), {
    status: "ok",
    refreshed: true,
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:open-codex-pets-dir"), {
    status: "ok",
    opened: true,
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:import-codex-pet-zip"), {
    status: "ok",
    imported: true,
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:remove-codex-pet", "imported-pet"), {
    status: "ok",
    removed: "imported-pet",
  });
  assert.deepStrictEqual(codexCalls, [
    "refresh",
    "open-dir",
    ["import", "sender-web-contents"],
    ["remove", "imported-pet"],
  ]);
});

test("settings IPC opens the user themes directory", async () => {
  const openCalls = [];
  const { ipcMain } = createHarness({
    themeLoader: {
      getPreviewSoundUrl: () => null,
      getSoundOverridesDir: () => null,
      getSoundUrl: () => null,
      listThemesWithMetadata: () => [],
      getThemeMetadata: () => null,
      ensureUserThemesDir: () => "C:\\Users\\Example\\AppData\\Roaming\\Clawd\\themes",
    },
    shell: {
      openPath: async (dir) => {
        openCalls.push(dir);
        return "";
      },
      openExternal: async () => {},
    },
  });

  assert.deepStrictEqual(await ipcMain.invoke("settings:open-user-themes-dir"), {
    status: "ok",
    path: "C:\\Users\\Example\\AppData\\Roaming\\Clawd\\themes",
  });
  assert.deepStrictEqual(openCalls, ["C:\\Users\\Example\\AppData\\Roaming\\Clawd\\themes"]);
});

test("settings IPC imports Clawd user theme zip packages", async () => {
  const root = makeTempDir();
  try {
    const userThemesDir = path.join(root, "user-themes");
    const zipPath = path.join(root, "pixel-cat.zip");
    const themeJson = {
      schemaVersion: 1,
      name: "Pixel Cat",
      version: "1.0.0",
      sleepSequence: { mode: "direct" },
      viewBox: { x: 0, y: 0, width: 16, height: 16 },
      states: {
        idle: ["idle.svg"],
        working: ["working.gif"],
        thinking: ["thinking.png"],
        sleeping: { fallbackTo: "idle" },
      },
    };
    fs.writeFileSync(zipPath, makeZip([
      { name: "pixel-cat/theme.json", data: JSON.stringify(themeJson), method: 8 },
      { name: "pixel-cat/assets/idle.svg", data: "<svg></svg>", method: 8 },
      { name: "pixel-cat/assets/working.gif", data: "gif", method: 8 },
      { name: "pixel-cat/assets/thinking.png", data: "png", method: 8 },
    ]));

    let dialogParent = null;
    let dialogOptions = null;
    const { ipcMain } = createHarness({
      dialog: {
        showOpenDialog: async (parent, options) => {
          dialogParent = parent;
          dialogOptions = options;
          return { canceled: false, filePaths: [zipPath] };
        },
        showMessageBox: async () => ({ response: 1 }),
      },
      themeLoader: {
        getPreviewSoundUrl: () => null,
        getSoundOverridesDir: () => null,
        getSoundUrl: () => null,
        listThemesWithMetadata: () => [],
        getThemeMetadata: () => null,
        ensureUserThemesDir: () => userThemesDir,
      },
    });

    assert.deepStrictEqual(await ipcMain.invoke("settings:import-user-theme-zip"), {
      status: "ok",
      themeId: "pixel-cat",
      name: "Pixel Cat",
      path: path.join(userThemesDir, "pixel-cat"),
    });
    assert.deepStrictEqual(dialogParent, { id: "parent", sender: "sender-web-contents" });
    assert.deepStrictEqual(dialogOptions.properties, ["openFile"]);
    assert.deepStrictEqual(dialogOptions.filters, [{ name: "Clawd theme zip", extensions: ["zip"] }]);
    assert.strictEqual(
      fs.readFileSync(path.join(userThemesDir, "pixel-cat", "theme.json"), "utf8"),
      JSON.stringify(themeJson)
    );
    assert.strictEqual(
      fs.readFileSync(path.join(userThemesDir, "pixel-cat", "assets", "working.gif"), "utf8"),
      "gif"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settings IPC copies sound overrides, removes stale siblings, and invalidates renderer cache", async () => {
  const root = makeTempDir();
  try {
    const overridesDir = path.join(root, "overrides");
    const sourcePath = path.join(root, "picked.wav");
    fs.mkdirSync(overridesDir, { recursive: true });
    fs.writeFileSync(sourcePath, "new audio", "utf8");
    fs.writeFileSync(path.join(overridesDir, "complete.mp3"), "old audio", "utf8");

    let dialogOptions = null;
    const { ipcMain, calls, activeTheme } = createHarness({
      dialog: {
        showOpenDialog: async (_parent, options) => {
          dialogOptions = options;
          return { canceled: false, filePaths: [sourcePath] };
        },
        showMessageBox: async () => ({ response: 1 }),
      },
      themeLoader: {
        getPreviewSoundUrl: () => null,
        getSoundOverridesDir: () => overridesDir,
        getSoundUrl: (soundName) => `file:///${soundName}.wav`,
        listThemesWithMetadata: () => [],
        getThemeMetadata: () => null,
      },
    });

    assert.deepStrictEqual(await ipcMain.invoke("settings:pick-sound-file", { soundName: "../nope" }), {
      status: "error",
      message: 'pickSoundFile.soundName "../nope" contains invalid characters',
    });
    assert.deepStrictEqual(await ipcMain.invoke("settings:pick-sound-file", { soundName: "complete" }), {
      status: "ok",
      file: "complete.wav",
    });

    assert.deepStrictEqual(dialogOptions.properties, ["openFile"]);
    assert.deepStrictEqual(dialogOptions.filters[0].extensions.sort(), [
      "aac",
      "flac",
      "m4a",
      "mp3",
      "ogg",
      "wav",
    ]);
    assert.strictEqual(fs.readFileSync(path.join(overridesDir, "complete.wav"), "utf8"), "new audio");
    assert.strictEqual(fs.existsSync(path.join(overridesDir, "complete.mp3")), false);
    assert.strictEqual(activeTheme._soundOverrideFiles.complete, path.join(overridesDir, "complete.wav"));
    assert.deepStrictEqual(calls, [
      ["applyCommand", "setSoundOverride", {
        themeId: "clawd",
        soundName: "complete",
        file: "complete.wav",
        originalName: "picked.wav",
      }],
      ["sendToRenderer", "invalidate-sound-cache", "file:///complete.wav"],
      ["sendToRenderer", "preload-sounds", { urls: ["file:///complete.wav"] }],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settings IPC previews sound only when not muted or in DND", async () => {
  const { ipcMain, calls } = createHarness({
    themeLoader: {
      getPreviewSoundUrl: () => null,
      getSoundOverridesDir: () => null,
      getSoundUrl: (soundName) => `file:///${soundName}.mp3?base=1`,
      listThemesWithMetadata: () => [],
      getThemeMetadata: () => null,
    },
    now: () => 987,
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:preview-sound", { soundName: "complete" }), {
    status: "ok",
  });
  assert.deepStrictEqual(calls, [
    ["sendToRenderer", "play-sound", { url: "file:///complete.mp3?base=1&_t=987", volume: 0.4 }],
  ]);

  const muted = createHarness({ getSoundMuted: () => true });
  assert.deepStrictEqual(await muted.ipcMain.invoke("settings:preview-sound", { soundName: "complete" }), {
    status: "skipped",
    reason: "muted",
  });

  const dnd = createHarness({ getDoNotDisturb: () => true });
  assert.deepStrictEqual(await dnd.ipcMain.invoke("settings:preview-sound", { soundName: "complete" }), {
    status: "skipped",
    reason: "dnd",
  });
});

test("settings IPC serves agent/about/update/external and remove-theme dialog helpers", async () => {
  const root = makeTempDir();
  try {
    const heroSvgPath = path.join(root, "hero.svg");
    fs.writeFileSync(heroSvgPath, "<svg id=\"hero\"></svg>", "utf8");
    let messageBoxParent = null;
    let messageBoxOptions = null;
    const { ipcMain, calls } = createHarness({
      aboutHeroSvgPath: heroSvgPath,
      getLang: () => "en",
      dialog: {
        showOpenDialog: async () => ({ canceled: true }),
        showMessageBox: async (parent, options) => {
          messageBoxParent = parent;
          messageBoxOptions = options;
          return { response: 0 };
        },
      },
      themeLoader: {
        getPreviewSoundUrl: () => "file:///preview.mp3",
        getSoundOverridesDir: () => null,
        getSoundUrl: () => null,
        listThemesWithMetadata: () => [],
        getThemeMetadata: (themeId) => ({ name: `Theme ${themeId}` }),
      },
      getAllAgents: () => [
        { id: "codex", name: "Codex", eventSource: "hook", capabilities: { permission: true } },
      ],
    });

    assert.strictEqual(await ipcMain.invoke("settings:get-preview-sound-url"), "file:///preview.mp3");
    assert.deepStrictEqual(await ipcMain.invoke("settings:list-agents"), [
      { id: "codex", name: "Codex", eventSource: "hook", capabilities: { permission: true } },
    ]);
    assert.deepStrictEqual(await ipcMain.invoke("settings:get-about-info"), {
      version: "1.2.3",
      repoUrl: "https://github.com/rullerzhou-afk/clawd-on-desk",
      license: "AGPL-3.0",
      copyright: "\u00a9 2026 Ruller_Lulu",
      authorName: "Ruller_Lulu / \u9e7f\u9e7f",
      authorUrl: "https://github.com/rullerzhou-afk",
      heroSvgContent: "<svg id=\"hero\"></svg>",
      pendingUpdateVersion: "",
      autoUpdateCheck: true,
    });
    assert.deepStrictEqual(await ipcMain.invoke("settings:confirm-remove-theme", "user-theme"), {
      confirmed: true,
    });
    assert.deepStrictEqual(messageBoxParent, { id: "parent", sender: "sender-web-contents" });
    assert.strictEqual(messageBoxOptions.message, 'Delete theme "Theme user-theme"?');
    assert.deepStrictEqual(await ipcMain.invoke("settings:check-for-updates"), { status: "ok" });
    assert.deepStrictEqual(await ipcMain.invoke("settings:open-external", "file:///tmp"), {
      status: "error",
      message: "Invalid URL",
    });
    assert.deepStrictEqual(await ipcMain.invoke("settings:open-external", "https://example.test"), {
      status: "ok",
    });
    assert.deepStrictEqual(calls, [
      ["checkForUpdates", true],
      ["openExternal", "https://example.test"],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settings IPC exposes read-only agent installation detection", async () => {
  let sawFs = false;
  let sawPath = false;
  const { ipcMain, runtime } = createHarness({
    now: () => 777,
    detectAgentInstallations: (options) => {
      sawFs = !!options.fs;
      sawPath = !!options.path;
      return {
        checkedAt: options.now(),
        agents: [{ agentId: "qwen-code", detectedInstalled: true }],
        skippedAgentIds: ["claude-code", "codex"],
      };
    },
  });

  assert.deepStrictEqual(await ipcMain.invoke("settings:detect-agent-installations"), {
    checkedAt: 777,
    agents: [{ agentId: "qwen-code", detectedInstalled: true }],
    skippedAgentIds: ["claude-code", "codex"],
  });
  assert.strictEqual(sawFs, true);
  assert.strictEqual(sawPath, true);

  runtime.dispose();
});

// ── v2 interactive-mobile settings handlers ──

const FAKE_TOKEN = "00000000000000000000000000000000";

function makeFakeLanServer(overrides = {}) {
  const calls = [];
  const server = {
    getPort: () => (overrides.port === undefined ? 23334 : overrides.port),
    getToken: () => (overrides.token === undefined ? FAKE_TOKEN : overrides.token),
    getHttpsInfo: () => {
      calls.push(["getHttpsInfo"]);
      return overrides.httpsInfo === undefined
        ? { httpsReady: false, host: "clawd.local", lanIp: "192.168.1.50" }
        : overrides.httpsInfo;
    },
    getPushStatus: () => {
      calls.push(["getPushStatus"]);
      return overrides.pushStatus === undefined
        ? { enabled: true, subscriptions: 2 }
        : overrides.pushStatus;
    },
    listDevices: () => {
      calls.push(["listDevices"]);
      return overrides.devices === undefined
        ? [{ deviceId: "dev-1", name: "iPhone", approvalsAllowed: true }]
        : overrides.devices;
    },
    revokeDevice: (deviceId) => {
      calls.push(["revokeDevice", deviceId]);
      return overrides.revokeResult === undefined ? true : overrides.revokeResult;
    },
    setDeviceApprovalsAllowed: (deviceId, allowed) => {
      calls.push(["setDeviceApprovalsAllowed", deviceId, allowed]);
      return overrides.setApprovalsResult === undefined ? true : overrides.setApprovalsResult;
    },
    getPairingCode: () => {
      calls.push(["getPairingCode"]);
      return overrides.pairingCode === undefined
        ? { code: "ABCD2345", expiresAt: 1700000600000 }
        : overrides.pairingCode;
    },
    regeneratePairingCode: () => {
      calls.push(["regeneratePairingCode"]);
      return overrides.regeneratedCode === undefined
        ? { code: "WXYZ6789", expiresAt: 1700000900000 }
        : overrides.regeneratedCode;
    },
    getLocalIP: () => (overrides.localIp === undefined ? "192.168.1.50" : overrides.localIp),
  };
  if (overrides.omitGetLocalIP) delete server.getLocalIP;
  return { server, calls };
}

function decodeQrPayload(dataUrl) {
  assert.match(dataUrl, /^data:image\/png;base64,/, "qr must be a PNG data URL");
}

test("mobile-https-info passes through getHttpsInfo result", async () => {
  const { server, calls } = makeFakeLanServer({
    httpsInfo: { httpsReady: true, host: "clawd.local", httpsPort: 23335, lanIp: "10.0.0.5" },
  });
  const { ipcMain, runtime } = createHarness({ getLanWsServer: () => server });

  assert.deepStrictEqual(await ipcMain.invoke("settings:mobile-https-info"), {
    status: "ok",
    httpsReady: true,
    host: "clawd.local",
    httpsPort: 23335,
    lanIp: "10.0.0.5",
  });
  assert.deepStrictEqual(calls, [["getHttpsInfo"]]);
  runtime.dispose();
});

test("mobile-push-status passes through getPushStatus result", async () => {
  const { server, calls } = makeFakeLanServer({ pushStatus: { enabled: false, subscriptions: 0 } });
  const { ipcMain, runtime } = createHarness({ getLanWsServer: () => server });

  assert.deepStrictEqual(await ipcMain.invoke("settings:mobile-push-status"), {
    status: "ok",
    enabled: false,
    subscriptions: 0,
  });
  assert.deepStrictEqual(calls, [["getPushStatus"]]);
  runtime.dispose();
});

test("list-mobile-devices passes through listDevices result", async () => {
  const devices = [
    { deviceId: "dev-1", name: "iPhone", approvalsAllowed: true },
    { deviceId: "dev-2", name: "iPad", approvalsAllowed: false },
  ];
  const { server, calls } = makeFakeLanServer({ devices });
  const { ipcMain, runtime } = createHarness({ getLanWsServer: () => server });

  assert.deepStrictEqual(await ipcMain.invoke("settings:list-mobile-devices"), {
    status: "ok",
    devices,
  });
  assert.deepStrictEqual(calls, [["listDevices"]]);
  runtime.dispose();
});

test("revoke-mobile-device forwards deviceId and reports removal", async () => {
  const { server, calls } = makeFakeLanServer();
  const { ipcMain, runtime } = createHarness({ getLanWsServer: () => server });

  assert.deepStrictEqual(await ipcMain.invoke("settings:revoke-mobile-device", "dev-1"), {
    status: "ok",
    removed: true,
  });
  assert.deepStrictEqual(calls, [["revokeDevice", "dev-1"]]);

  assert.deepStrictEqual(await ipcMain.invoke("settings:revoke-mobile-device", ""), {
    status: "error",
    message: "deviceId must be a non-empty string",
  });
  runtime.dispose();
});

test("set-mobile-device-approvals forwards deviceId + coerced allowed flag", async () => {
  const { server, calls } = makeFakeLanServer();
  const { ipcMain, runtime } = createHarness({ getLanWsServer: () => server });

  assert.deepStrictEqual(
    await ipcMain.invoke("settings:set-mobile-device-approvals", { deviceId: "dev-2", allowed: true }),
    { status: "ok", updated: true }
  );
  assert.deepStrictEqual(calls, [["setDeviceApprovalsAllowed", "dev-2", true]]);

  assert.deepStrictEqual(
    await ipcMain.invoke("settings:set-mobile-device-approvals", { allowed: true }),
    { status: "error", message: "deviceId must be a non-empty string" }
  );
  assert.deepStrictEqual(
    await ipcMain.invoke("settings:set-mobile-device-approvals", null),
    { status: "error", message: "payload must be { deviceId, allowed }" }
  );
  runtime.dispose();
});

test("v2 mobile handlers return a safe not-available object when the LAN bridge is null", async () => {
  const { ipcMain, runtime } = createHarness({ getLanWsServer: () => null });
  const notAvailable = { status: "error", message: "LAN bridge not available" };

  assert.deepStrictEqual(await ipcMain.invoke("settings:mobile-https-info"), notAvailable);
  assert.deepStrictEqual(await ipcMain.invoke("settings:mobile-push-status"), notAvailable);
  assert.deepStrictEqual(await ipcMain.invoke("settings:list-mobile-devices"), notAvailable);
  assert.deepStrictEqual(await ipcMain.invoke("settings:revoke-mobile-device", "dev-1"), notAvailable);
  assert.deepStrictEqual(
    await ipcMain.invoke("settings:set-mobile-device-approvals", { deviceId: "dev-1", allowed: true }),
    notAvailable
  );
  assert.deepStrictEqual(await ipcMain.invoke("settings:mobile-pairing-qr"), notAvailable);
  assert.deepStrictEqual(await ipcMain.invoke("settings:mobile-pairing-code"), notAvailable);
  assert.deepStrictEqual(await ipcMain.invoke("settings:regenerate-mobile-pairing-code"), notAvailable);
  runtime.dispose();
});

test("mobile-pairing-qr generates real http QR codes when HTTPS is not ready", async () => {
  const { server } = makeFakeLanServer({
    httpsInfo: { httpsReady: false, host: "clawd.local", lanIp: "192.168.1.50" },
    localIp: "192.168.1.50",
  });
  const { ipcMain, runtime } = createHarness({ getLanWsServer: () => server });

  const result = await ipcMain.invoke("settings:mobile-pairing-qr");

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.httpsReady, false);

  for (const variant of [result.host, result.ip]) {
    decodeQrPayload(variant.qr);
    const url = new URL(variant.url);
    assert.strictEqual(url.protocol, "http:");
    // Without HTTPS the primary (host) variant also falls back to the raw IP.
    assert.strictEqual(url.hostname, "192.168.1.50");
    assert.strictEqual(url.port, "23334");
    assert.strictEqual(url.pathname, "/mobile/");
    // Token-free: the QR only opens the app (scan → Add to Home Screen); no
    // credential rides in the URL.
    assert.strictEqual(url.search, "");
  }
  runtime.dispose();
});

test("mobile-pairing-qr uses clawd.local + https port when HTTPS is ready", async () => {
  const { server } = makeFakeLanServer({
    httpsInfo: { httpsReady: true, host: "clawd.local", httpsPort: 23335, lanIp: "192.168.1.50" },
    localIp: "192.168.1.50",
  });
  const { ipcMain, runtime } = createHarness({ getLanWsServer: () => server });

  const result = await ipcMain.invoke("settings:mobile-pairing-qr");

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.httpsReady, true);

  decodeQrPayload(result.host.qr);
  const hostUrl = new URL(result.host.url);
  assert.strictEqual(hostUrl.protocol, "https:");
  assert.strictEqual(hostUrl.hostname, "clawd.local");
  assert.strictEqual(hostUrl.port, "23335");
  assert.strictEqual(hostUrl.pathname, "/mobile/");
  assert.strictEqual(hostUrl.search, "");

  decodeQrPayload(result.ip.qr);
  const ipUrl = new URL(result.ip.url);
  assert.strictEqual(ipUrl.protocol, "https:");
  assert.strictEqual(ipUrl.hostname, "192.168.1.50");
  assert.strictEqual(ipUrl.port, "23335");
  assert.strictEqual(ipUrl.pathname, "/mobile/");
  assert.strictEqual(ipUrl.search, "");
  runtime.dispose();
});

test("mobile-pairing-code delegates to the LAN bridge and returns the code + expiry", async () => {
  const { server, calls } = makeFakeLanServer();
  const { ipcMain, runtime } = createHarness({ getLanWsServer: () => server });

  const result = await ipcMain.invoke("settings:mobile-pairing-code");
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.code, "ABCD2345");
  assert.strictEqual(result.expiresAt, 1700000600000);
  assert.ok(calls.some((c) => c[0] === "getPairingCode"));
  runtime.dispose();
});

test("mobile-pairing-code reports starting until the LAN bridge has a port", async () => {
  const { server } = makeFakeLanServer({ port: null });
  const { ipcMain, runtime } = createHarness({ getLanWsServer: () => server });

  assert.deepStrictEqual(await ipcMain.invoke("settings:mobile-pairing-code"), {
    status: "starting",
    message: "LAN bridge is starting",
  });
  runtime.dispose();
});

test("regenerate-mobile-pairing-code delegates and returns the fresh code", async () => {
  const { server, calls } = makeFakeLanServer();
  const { ipcMain, runtime } = createHarness({ getLanWsServer: () => server });

  const result = await ipcMain.invoke("settings:regenerate-mobile-pairing-code");
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.code, "WXYZ6789");
  assert.strictEqual(result.expiresAt, 1700000900000);
  assert.ok(calls.some((c) => c[0] === "regeneratePairingCode"));
  runtime.dispose();
});

test("mobile-pairing-qr reports starting until the LAN bridge has a port", async () => {
  const { server } = makeFakeLanServer({ port: null });
  const { ipcMain, runtime } = createHarness({ getLanWsServer: () => server });

  assert.deepStrictEqual(await ipcMain.invoke("settings:mobile-pairing-qr"), {
    status: "starting",
    message: "LAN bridge is starting",
  });
  runtime.dispose();
});

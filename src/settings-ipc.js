"use strict";

const defaultFs = require("fs");
const defaultPath = require("path");
const { detectAgentInstallations: defaultDetectAgentInstallations } = require("./agent-installation-detector");
const settingsThemeImporter = require("./settings-theme-importer");

const SOUND_OVERRIDE_ASSET_EXTS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"]);
const SOUND_OVERRIDE_DIALOG_STRINGS = {
  en: { title: "Choose a sound file", filterName: "Audio" },
  zh: { title: "选择音效文件", filterName: "音频" },
  "zh-TW": { title: "選擇音效檔案", filterName: "音效" },
  ko: { title: "음향 파일 선택", filterName: "오디오" },
  ja: { title: "音声ファイルを選択", filterName: "音声" },
};

const REMOVE_THEME_DIALOG_STRINGS = {
  en: {
    delete: "Delete",
    cancel: "Cancel",
    message: (name) => `Delete theme "${name}"?`,
    detail: "This cannot be undone. All files for this theme will be removed from disk.",
  },
  zh: {
    delete: "删除",
    cancel: "取消",
    message: (name) => `确认删除主题 "${name}"？`,
    detail: "此操作不可撤销。主题的所有文件将从磁盘移除。",
  },
  "zh-TW": {
    delete: "刪除",
    cancel: "取消",
    message: (name) => `確定要刪除主題「${name}」？`,
    detail: "此動作無法復原。此主題的所有檔案都會從磁碟移除。",
  },
  ko: {
    delete: "삭제",
    cancel: "취소",
    message: (name) => `테마 "${name}"을(를) 삭제할까요?`,
    detail: "이 작업은 되돌릴 수 없습니다. 이 테마의 모든 파일이 디스크에서 제거됩니다.",
  },
  ja: {
    delete: "削除",
    cancel: "キャンセル",
    message: (name) => `テーマ "${name}" を削除しますか？`,
    detail: "この操作は元に戻せません。このテーマのすべてのファイルがディスクから削除されます。",
  },
};

function requiredDependency(value, name) {
  if (!value) throw new Error(`registerSettingsIpc requires ${name}`);
  return value;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getSettingsDialogParent(event, { BrowserWindow, getSettingsWindow }) {
  const sender = event && event.sender;
  const fromSender = sender && BrowserWindow && typeof BrowserWindow.fromWebContents === "function"
    ? BrowserWindow.fromWebContents(sender)
    : null;
  return fromSender || (typeof getSettingsWindow === "function" ? getSettingsWindow() : null) || null;
}

function cleanupSiblingSoundOverrides(fs, path, overridesDir, soundName, keepExt) {
  let entries;
  try { entries = fs.readdirSync(overridesDir); }
  catch { return; }
  for (const entry of entries) {
    if (path.parse(entry).name !== soundName) continue;
    if (path.extname(entry).toLowerCase() === keepExt) continue;
    try { fs.unlinkSync(path.join(overridesDir, entry)); } catch {}
  }
}

function rememberRuntimeSoundOverrideFile({ getActiveTheme }, themeId, soundName, absPath) {
  const activeTheme = getActiveTheme();
  if (!activeTheme || activeTheme._id !== themeId) return;
  if (typeof soundName !== "string" || !soundName) return;
  if (typeof absPath !== "string" || !absPath) return;
  const nextOverrideMap = isPlainObject(activeTheme._soundOverrideFiles)
    ? { ...activeTheme._soundOverrideFiles }
    : {};
  nextOverrideMap[soundName] = absPath;
  activeTheme._soundOverrideFiles = nextOverrideMap;
}

function mapAgentMetadata(agent) {
  return {
    id: agent.id,
    name: agent.name,
    eventSource: agent.eventSource,
    capabilities: agent.capabilities || {},
  };
}

function registerSettingsIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain");
  const settingsController = requiredDependency(options.settingsController, "settingsController");
  const themeLoader = requiredDependency(options.themeLoader, "themeLoader");
  const codexPetMain = requiredDependency(options.codexPetMain, "codexPetMain");
  const dialog = requiredDependency(options.dialog, "dialog");
  const shell = requiredDependency(options.shell, "shell");
  const app = requiredDependency(options.app, "app");
  const BrowserWindow = requiredDependency(options.BrowserWindow, "BrowserWindow");
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const getSettingsWindow = options.getSettingsWindow || (() => null);
  const getActiveTheme = options.getActiveTheme || (() => null);
  const getLang = options.getLang || (() => "en");
  const settingsSizePreviewSession = requiredDependency(
    options.settingsSizePreviewSession,
    "settingsSizePreviewSession"
  );
  const isValidSizePreviewKey = requiredDependency(
    options.isValidSizePreviewKey,
    "isValidSizePreviewKey"
  );
  const sendToRenderer = options.sendToRenderer || (() => {});
  const getDoNotDisturb = options.getDoNotDisturb || (() => false);
  const getSoundMuted = options.getSoundMuted || (() => false);
  const getSoundVolume = options.getSoundVolume || (() => 1);
  const previewTextScale = options.previewTextScale
    || (() => ({ status: "error", message: "text scale preview unavailable" }));
  const endTextScalePreview = options.endTextScalePreview
    || (() => ({ status: "error", message: "text scale preview unavailable" }));
  const getTextScaleContext = options.getTextScaleContext
    || (() => ({ percent: 100 }));
  const getAllAgents = requiredDependency(options.getAllAgents, "getAllAgents");
  const detectAgentInstallations = options.detectAgentInstallations || defaultDetectAgentInstallations;
  const checkForUpdates = options.checkForUpdates || (() => {});
  const getHardwareBuddyStatus = options.getHardwareBuddyStatus || (() => null);
  const testHardwareBuddyApproval = options.testHardwareBuddyApproval || (async () => ({
    status: "error",
    message: "Hardware Buddy test approval is unavailable",
  }));
  const getQuickCommandPresets = options.getQuickCommandPresets || (() => ({
    enabled: false,
    presets: [],
  }));
  const sendQuickCommand = options.sendQuickCommand || (() => ({
    status: "error",
    code: "quick_commands_unavailable",
    message: "Quick Commands are unavailable",
  }));
  const showTutorial = options.showTutorial || (() => ({
    status: "error",
    message: "Tutorial is unavailable",
  }));
  const now = options.now || (() => Date.now());
  const aboutHeroSvgPath = options.aboutHeroSvgPath
    || path.join(__dirname, "..", "assets", "svg", "clawd-about-hero.svg");
  const disposers = [];

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => ipcMain.removeHandler(channel));
  }

  function sanitizeQuickCommandPayload(payload) {
    const object = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    return {
      id: object.id,
      clientRequestId: object.clientRequestId,
    };
  }

  function getDialogParent(event) {
    return getSettingsDialogParent(event, { BrowserWindow, getSettingsWindow });
  }

  handle("settings:get-snapshot", () => settingsController.getSnapshot());
  handle("settings:update", (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      return { status: "error", message: "settings:update payload must be { key, value }" };
    }
    if (payload.key === "tgMigration") {
      return { status: "error", message: "tgMigration is internal; use telegramMigration.dispatch" };
    }
    // DANGER "auto-pilot": never let a plain settings:update flip this on. It
    // must go through the setAutoApproveAll command, which demands confirmed:true.
    // This makes the confirmation dialog a real boundary instead of UI-only.
    if (payload.key === "autoApproveAllPermissions") {
      return { status: "error", message: "autoApproveAllPermissions is gated; use the setAutoApproveAll command" };
    }
    return settingsController.applyUpdate(payload.key, payload.value);
  });
  handle("settings:begin-size-preview", () => settingsSizePreviewSession.begin());
  handle("settings:preview-size", (_event, value) => {
    if (!isValidSizePreviewKey(value)) {
      return { status: "error", message: `invalid preview size "${value}"` };
    }
    return settingsSizePreviewSession.preview(value).then(() => ({ status: "ok" }));
  });
  handle("settings:end-size-preview", (_event, value) => {
    if (value !== null && value !== undefined && !isValidSizePreviewKey(value)) {
      return { status: "error", message: `invalid preview size "${value}"` };
    }
    return settingsSizePreviewSession.end(value || null);
  });
  // Transient textScale preview while the slider drags: applies zoom to live
  // windows but never writes the store. Commit still goes through
  // settings:update so the controller stays the only writer.
  handle("settings:preview-text-scale", (_event, value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return { status: "error", message: `invalid text scale "${value}"` };
    }
    return previewTextScale(n);
  });
  handle("settings:end-text-scale-preview", () => endTextScalePreview());
  // textScale is per-display; the renderer can't resolve its own display, so
  // the slider asks main for the committed value of the display the settings
  // window currently sits on.
  handle("settings:get-text-scale-context", () => getTextScaleContext());
  handle("settings:get-preview-sound-url", () => {
    try { return themeLoader.getPreviewSoundUrl(); }
    catch { return null; }
  });
  handle("settings:command", async (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      return { status: "error", message: "settings:command payload must be { action, payload }" };
    }
    return settingsController.applyCommand(payload.action, payload.payload);
  });

  handle("settings:pick-sound-file", async (event, payload) => {
    if (!payload || typeof payload !== "object") {
      return { status: "error", message: "pickSoundFile payload must be an object" };
    }
    const { soundName } = payload;
    if (typeof soundName !== "string" || !soundName) {
      return { status: "error", message: "pickSoundFile.soundName must be a non-empty string" };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(soundName)) {
      return { status: "error", message: `pickSoundFile.soundName "${soundName}" contains invalid characters` };
    }

    const activeTheme = getActiveTheme();
    if (!activeTheme) return { status: "error", message: "no active theme" };
    const themeId = activeTheme._id;
    if (!isPlainObject(activeTheme.sounds) || !activeTheme.sounds[soundName]) {
      return { status: "error", message: `sound "${soundName}" not declared by theme "${themeId}"` };
    }
    const overridesDir = themeLoader.getSoundOverridesDir(themeId);
    if (!overridesDir) return { status: "error", message: "sound-overrides directory unavailable" };

    const lang = getLang();
    const strings = SOUND_OVERRIDE_DIALOG_STRINGS[lang] || SOUND_OVERRIDE_DIALOG_STRINGS.en;
    const extList = [...SOUND_OVERRIDE_ASSET_EXTS].map((ext) => ext.slice(1));
    let result;
    try {
      result = await dialog.showOpenDialog(getDialogParent(event), {
        title: strings.title,
        filters: [{ name: strings.filterName, extensions: extList }],
        properties: ["openFile"],
      });
    } catch (err) {
      return { status: "error", message: `pick dialog failed: ${err && err.message}` };
    }
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { status: "cancel" };
    }

    const sourcePath = result.filePaths[0];
    const ext = path.extname(sourcePath).toLowerCase();
    if (!SOUND_OVERRIDE_ASSET_EXTS.has(ext)) {
      return { status: "error", message: `unsupported audio extension: ${ext || "(none)"}` };
    }

    try { fs.mkdirSync(overridesDir, { recursive: true }); }
    catch (err) { return { status: "error", message: `mkdir failed: ${err && err.message}` }; }

    const destFilename = `${soundName}${ext}`;
    const destPath = path.join(overridesDir, destFilename);
    try {
      fs.copyFileSync(sourcePath, destPath);
    } catch (err) {
      return { status: "error", message: `copy failed: ${err && err.message}` };
    }
    cleanupSiblingSoundOverrides(fs, path, overridesDir, soundName, ext);

    const cmdResult = await settingsController.applyCommand("setSoundOverride", {
      themeId,
      soundName,
      file: destFilename,
      originalName: path.basename(sourcePath),
    });
    if (!cmdResult || cmdResult.status !== "ok") {
      return cmdResult || { status: "error", message: "setSoundOverride failed" };
    }
    rememberRuntimeSoundOverrideFile({ getActiveTheme }, themeId, soundName, destPath);
    const newUrl = themeLoader.getSoundUrl(soundName);
    if (newUrl) {
      sendToRenderer("invalidate-sound-cache", newUrl);
      sendToRenderer("preload-sounds", { urls: [newUrl] });
    }
    return { status: "ok", file: destFilename };
  });

  handle("settings:preview-sound", (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      return { status: "error", message: "previewSound payload must be an object" };
    }
    const { soundName } = payload;
    if (typeof soundName !== "string" || !soundName) {
      return { status: "error", message: "previewSound.soundName must be a non-empty string" };
    }
    if (getDoNotDisturb()) return { status: "skipped", reason: "dnd" };
    if (getSoundMuted()) return { status: "skipped", reason: "muted" };
    const url = themeLoader.getSoundUrl(soundName);
    if (!url) return { status: "error", message: "sound unavailable" };
    const bustedUrl = `${url}${url.includes("?") ? "&" : "?"}_t=${now()}`;
    sendToRenderer("play-sound", { url: bustedUrl, volume: getSoundVolume() });
    return { status: "ok" };
  });

  handle("settings:open-sound-overrides-dir", async () => {
    const activeTheme = getActiveTheme();
    if (!activeTheme) return { status: "error", message: "no active theme" };
    const dir = themeLoader.getSoundOverridesDir(activeTheme._id);
    if (!dir) return { status: "error", message: "sound-overrides directory unavailable" };
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const openResult = await shell.openPath(dir);
    if (openResult) return { status: "error", message: openResult };
    return { status: "ok", path: dir };
  });

  handle("settings:list-themes", () => {
    try {
      const activeTheme = getActiveTheme();
      const activeId = activeTheme ? activeTheme._id : "clawd";
      return themeLoader.listThemesWithMetadata().map((theme) =>
        codexPetMain.decorateThemeMetadata({
          ...theme,
          active: theme.id === activeId,
        })
      );
    } catch (err) {
      console.warn("Clawd: settings:list-themes failed:", err && err.message);
      return [];
    }
  });

  handle("settings:open-user-themes-dir", async () => {
    const dir = typeof themeLoader.ensureUserThemesDir === "function"
      ? themeLoader.ensureUserThemesDir()
      : null;
    if (!dir) return { status: "error", message: "user themes directory unavailable" };
    const openResult = await shell.openPath(dir);
    if (openResult) return { status: "error", message: openResult };
    return { status: "ok", path: dir };
  });

  handle("settings:import-user-theme-zip", async (event) => {
    let result;
    try {
      result = await dialog.showOpenDialog(getDialogParent(event), {
        properties: ["openFile"],
        filters: [{ name: "Clawd theme zip", extensions: ["zip"] }],
      });
    } catch (err) {
      return { status: "error", message: `theme zip picker failed: ${err && err.message}` };
    }
    if (!result || result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { status: "cancel" };
    }

    try {
      const userThemesDir = typeof themeLoader.ensureUserThemesDir === "function"
        ? themeLoader.ensureUserThemesDir()
        : null;
      return settingsThemeImporter.importUserThemeZip(result.filePaths[0], {
        fs,
        path,
        userThemesDir,
      });
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  handle("settings:refresh-codex-pets", () => codexPetMain.refreshFromSettings());
  handle("settings:open-codex-pets-dir", () => codexPetMain.openCodexPetsDir());
  handle("settings:import-codex-pet-zip", (event) => codexPetMain.importCodexPetZip(event));
  handle("settings:remove-codex-pet", (_event, themeId) => codexPetMain.removeCodexPet(themeId));

  handle("settings:confirm-remove-theme", async (event, themeId) => {
    if (typeof themeId !== "string" || !themeId) return { confirmed: false };
    const meta = themeLoader.getThemeMetadata(themeId);
    const displayName = (meta && meta.name) || themeId;
    const lang = getLang();
    const strings = REMOVE_THEME_DIALOG_STRINGS[lang] || REMOVE_THEME_DIALOG_STRINGS.en;
    try {
      const { response } = await dialog.showMessageBox(getDialogParent(event), {
        type: "warning",
        buttons: [strings.delete, strings.cancel],
        defaultId: 1,
        cancelId: 1,
        message: strings.message(displayName),
        detail: strings.detail,
        noLink: true,
      });
      return { confirmed: response === 0 };
    } catch (err) {
      console.warn("Clawd: confirm-remove-theme dialog failed:", err && err.message);
      return { confirmed: false };
    }
  });

  handle("settings:list-agents", () => {
    try {
      return getAllAgents().map(mapAgentMetadata);
    } catch (err) {
      console.warn("Clawd: settings:list-agents failed:", err && err.message);
      return [];
    }
  });

  handle("settings:detect-agent-installations", () => {
    try {
      return detectAgentInstallations({ fs, path, now });
    } catch (err) {
      console.warn("Clawd: settings:detect-agent-installations failed:", err && err.message);
      return {
        checkedAt: now(),
        agents: [],
        skippedAgentIds: [],
        error: err && err.message ? err.message : String(err),
      };
    }
  });

  handle("settings:get-about-info", () => {
    let heroSvgContent = "";
    try {
      heroSvgContent = fs.readFileSync(aboutHeroSvgPath, "utf8");
    } catch (err) {
      console.warn("Clawd: failed to read about hero SVG:", err && err.message);
    }
    let pendingUpdateVersion = "";
    let autoUpdateCheck = true;
    try {
      pendingUpdateVersion = String(settingsController.get("pendingUpdateVersion") || "");
      autoUpdateCheck = settingsController.get("autoUpdateCheck") !== false;
    } catch {}
    return {
      version: app.getVersion(),
      repoUrl: "https://github.com/rullerzhou-afk/clawd-on-desk",
      license: "AGPL-3.0",
      copyright: "\u00a9 2026 Ruller_Lulu",
      authorName: "Ruller_Lulu / \u9e7f\u9e7f",
      authorUrl: "https://github.com/rullerzhou-afk",
      heroSvgContent,
      pendingUpdateVersion,
      autoUpdateCheck,
    };
  });

  handle("settings:check-for-updates", () => {
    try {
      checkForUpdates(true);
      return { status: "ok" };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  handle("settings:show-tutorial", async () => {
    try {
      const result = await showTutorial();
      return result || { status: "ok" };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  handle("settings:get-hardware-buddy-status", () => getHardwareBuddyStatus());
  handle("settings:test-hardware-buddy-approval", () => testHardwareBuddyApproval());
  handle("settings:get-quick-command-presets", () => getQuickCommandPresets());
  handle("settings:send-quick-command", (_event, payload) => sendQuickCommand(sanitizeQuickCommandPayload(payload)));

  handle("settings:open-external", async (_event, url) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      return { status: "error", message: "Invalid URL" };
    }
    try {
      await shell.openExternal(url);
      return { status: "ok" };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  handle("settings:mobile-connection-info", async () => {
    try {
      const lanWsServer = options.getLanWsServer ? options.getLanWsServer() : null;
      if (!lanWsServer) return { status: "error", message: "LAN bridge not available" };
      const port = lanWsServer.getPort();
      const tok = lanWsServer.getToken();
      if (!Number.isInteger(port) || port <= 0 || typeof tok !== "string" || !tok) {
        // A recorded bind failure (e.g. the configured port is occupied) is a hard
        // error to surface in Settings, not an endless "starting…".
        const bindErr = typeof lanWsServer.getHttpError === "function" ? lanWsServer.getHttpError() : null;
        if (bindErr) return { status: "error", lastError: bindErr, message: bindErr };
        return { status: "starting", message: "LAN bridge is starting" };
      }
      const os = require("os");
      let lanIp = "127.0.0.1";
      const interfaces = os.networkInterfaces();
      const wlanPattern = /WLAN|Wi-?Fi|Wireless|无线/i;
      // 1) 优先找 WLAN 接口
      for (const name of Object.keys(interfaces)) {
        if (wlanPattern.test(name)) {
          for (const iface of interfaces[name]) {
            if (iface.family === "IPv4" && !iface.internal) { lanIp = iface.address; break; }
          }
          if (lanIp !== "127.0.0.1") break;
        }
      }
      // 2) fallback：第一个非 internal IPv4
      if (lanIp === "127.0.0.1") {
        for (const name of Object.keys(interfaces)) {
          for (const iface of interfaces[name]) {
            if (iface.family === "IPv4" && !iface.internal) { lanIp = iface.address; break; }
          }
          if (lanIp !== "127.0.0.1") break;
        }
      }
      return { status: "ok", port, token: tok, lanIp };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  handle("settings:regenerate-mobile-token", async () => {
    try {
      const lanWsServer = options.getLanWsServer ? options.getLanWsServer() : null;
      if (!lanWsServer) return { status: "error", message: "LAN bridge not available" };
      const newToken = lanWsServer.regenerateToken();
      return { status: "ok", token: newToken };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  handle("settings:reset-mobile-access", async () => {
    try {
      const lanWsServer = options.getLanWsServer ? options.getLanWsServer() : null;
      if (!lanWsServer) return { status: "error", message: "LAN bridge not available" };
      const newToken = lanWsServer.resetMobileAccess();
      return { status: "ok", token: newToken };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  // ── v2 interactive-mobile settings ──

  handle("settings:mobile-https-info", async () => {
    try {
      const lanWsServer = options.getLanWsServer ? options.getLanWsServer() : null;
      if (!lanWsServer || typeof lanWsServer.getHttpsInfo !== "function") {
        return { status: "error", message: "LAN bridge not available" };
      }
      return { status: "ok", ...lanWsServer.getHttpsInfo() };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  handle("settings:mobile-push-status", async () => {
    try {
      const lanWsServer = options.getLanWsServer ? options.getLanWsServer() : null;
      if (!lanWsServer || typeof lanWsServer.getPushStatus !== "function") {
        return { status: "error", message: "LAN bridge not available" };
      }
      return { status: "ok", ...lanWsServer.getPushStatus() };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  handle("settings:list-mobile-devices", async () => {
    try {
      const lanWsServer = options.getLanWsServer ? options.getLanWsServer() : null;
      if (!lanWsServer || typeof lanWsServer.listDevices !== "function") {
        return { status: "error", message: "LAN bridge not available" };
      }
      return { status: "ok", devices: lanWsServer.listDevices() };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  handle("settings:revoke-mobile-device", async (_event, deviceId) => {
    if (typeof deviceId !== "string" || !deviceId) {
      return { status: "error", message: "deviceId must be a non-empty string" };
    }
    try {
      const lanWsServer = options.getLanWsServer ? options.getLanWsServer() : null;
      if (!lanWsServer || typeof lanWsServer.revokeDevice !== "function") {
        return { status: "error", message: "LAN bridge not available" };
      }
      const removed = lanWsServer.revokeDevice(deviceId);
      return { status: "ok", removed: !!removed };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  handle("settings:set-mobile-device-approvals", async (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      return { status: "error", message: "payload must be { deviceId, allowed }" };
    }
    const { deviceId, allowed } = payload;
    if (typeof deviceId !== "string" || !deviceId) {
      return { status: "error", message: "deviceId must be a non-empty string" };
    }
    try {
      const lanWsServer = options.getLanWsServer ? options.getLanWsServer() : null;
      if (!lanWsServer || typeof lanWsServer.setDeviceApprovalsAllowed !== "function") {
        return { status: "error", message: "LAN bridge not available" };
      }
      const ok = lanWsServer.setDeviceApprovalsAllowed(deviceId, !!allowed);
      return { status: "ok", updated: !!ok };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  handle("settings:set-mobile-device-transcript", async (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      return { status: "error", message: "payload must be { deviceId, allowed }" };
    }
    const { deviceId, allowed } = payload;
    if (typeof deviceId !== "string" || !deviceId) {
      return { status: "error", message: "deviceId must be a non-empty string" };
    }
    try {
      const lanWsServer = options.getLanWsServer ? options.getLanWsServer() : null;
      if (!lanWsServer || typeof lanWsServer.setDeviceTranscriptAllowed !== "function") {
        return { status: "error", message: "LAN bridge not available" };
      }
      const ok = lanWsServer.setDeviceTranscriptAllowed(deviceId, !!allowed);
      return { status: "ok", updated: !!ok };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  // Returns the live pairing code for the phone to type (4+4 OTP boxes). The
  // code is ephemeral and never persisted; it's the camera-free way the iOS
  // home-screen app bootstraps its first pairing.
  handle("settings:mobile-pairing-code", async () => {
    try {
      const lanWsServer = options.getLanWsServer ? options.getLanWsServer() : null;
      if (!lanWsServer || typeof lanWsServer.getPairingCode !== "function") {
        return { status: "error", message: "LAN bridge not available" };
      }
      const port = lanWsServer.getPort();
      if (!Number.isInteger(port) || port <= 0) {
        return { status: "starting", message: "LAN bridge is starting" };
      }
      const { code, expiresAt } = lanWsServer.getPairingCode();
      return { status: "ok", code, expiresAt };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  handle("settings:regenerate-mobile-pairing-code", async () => {
    try {
      const lanWsServer = options.getLanWsServer ? options.getLanWsServer() : null;
      if (!lanWsServer || typeof lanWsServer.regeneratePairingCode !== "function") {
        return { status: "error", message: "LAN bridge not available" };
      }
      const { code, expiresAt } = lanWsServer.regeneratePairingCode();
      return { status: "ok", code, expiresAt };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  // QR generation must happen main-side: the sandboxed settings preload can't
  // require app modules (incl. qrcode). This QR is token-free — it only opens
  // the PWA in Safari (scan → Add to Home Screen). Pairing is done inside the
  // installed app with the typed code above, never via a credential in the URL.
  handle("settings:mobile-pairing-qr", async () => {
    try {
      const lanWsServer = options.getLanWsServer ? options.getLanWsServer() : null;
      if (!lanWsServer) return { status: "error", message: "LAN bridge not available" };
      const port = lanWsServer.getPort();
      if (!Number.isInteger(port) || port <= 0) {
        return { status: "starting", message: "LAN bridge is starting" };
      }

      const httpsInfo = typeof lanWsServer.getHttpsInfo === "function"
        ? lanWsServer.getHttpsInfo()
        : null;
      const lanIp = typeof lanWsServer.getLocalIP === "function"
        ? lanWsServer.getLocalIP()
        : (httpsInfo && httpsInfo.lanIp) || "127.0.0.1";
      const host = (httpsInfo && httpsInfo.host) || "clawd.local";
      const httpsReady = !!(httpsInfo && httpsInfo.httpsReady && httpsInfo.httpsPort);

      // Prefer HTTPS so the installed app gets the secure context iOS needs for
      // the service worker, push, and write-approval.
      const scheme = httpsReady ? "https" : "http";
      const usePort = httpsReady ? httpsInfo.httpsPort : port;
      // The clawd.local variant stays DHCP-resilient (resolved via mDNS, only
      // advertised while HTTPS is up); the raw-IP variant is the fallback.
      const buildUrl = (authority) => `${scheme}://${authority}:${usePort}/mobile/`;
      const hostUrl = buildUrl(httpsReady ? host : lanIp);
      const ipUrl = buildUrl(lanIp);

      const QRCode = require("qrcode");
      const qrOpts = { errorCorrectionLevel: "M", margin: 1, width: 240 };
      const [hostQr, ipQr] = await Promise.all([
        QRCode.toDataURL(hostUrl, qrOpts),
        QRCode.toDataURL(ipUrl, qrOpts),
      ]);

      return {
        status: "ok",
        httpsReady,
        host: { url: hostUrl, qr: hostQr },
        ip: { url: ipUrl, qr: ipQr },
      };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  return {
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        try { dispose(); } catch {}
      }
    },
  };
}

module.exports = {
  registerSettingsIpc,
};

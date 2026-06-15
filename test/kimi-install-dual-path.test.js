const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  registerKimiHooksAllTargets,
  unregisterKimiHooksAllTargets,
  KIMI_HOOK_EVENTS,
} = require("../hooks/kimi-install");

const tempDirs = [];
function makeHome({ legacy = true, kimiCode = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-kimi-dual-"));
  if (legacy) fs.mkdirSync(path.join(home, ".kimi"), { recursive: true });
  if (kimiCode) fs.mkdirSync(path.join(home, ".kimi-code"), { recursive: true });
  tempDirs.push(home);
  return home;
}
function env(home) {
  return { HOME: home, USERPROFILE: home, KIMI_CODE_HOME: path.join(home, ".kimi-code") };
}
afterEach(() => { while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true }); });

describe("Kimi dual-path installer", () => {
  it("installs into both ~/.kimi and ~/.kimi-code, summing added counts", () => {
    const home = makeHome();
    const result = registerKimiHooksAllTargets({ silent: true, nodeBin: "/usr/local/bin/node", env: env(home) });
    assert.strictEqual(result.added, KIMI_HOOK_EVENTS.length * 2);
    assert.ok(fs.existsSync(path.join(home, ".kimi", "config.toml")));
    assert.ok(fs.existsSync(path.join(home, ".kimi-code", "config.toml")));
  });

  it("skips the absent target (only ~/.kimi-code present)", () => {
    const home = makeHome({ legacy: false, kimiCode: true });
    const result = registerKimiHooksAllTargets({ silent: true, nodeBin: "/usr/local/bin/node", env: env(home) });
    assert.strictEqual(result.added, KIMI_HOOK_EVENTS.length);
    assert.ok(!fs.existsSync(path.join(home, ".kimi", "config.toml")));
    assert.ok(fs.existsSync(path.join(home, ".kimi-code", "config.toml")));
  });

  it("is idempotent across both paths (skipped on re-run)", () => {
    const home = makeHome();
    const opts = { silent: true, nodeBin: "/usr/local/bin/node", env: env(home) };
    registerKimiHooksAllTargets(opts);
    const again = registerKimiHooksAllTargets(opts);
    assert.strictEqual(again.added, 0);
    assert.ok(again.skipped >= 1);
  });

  it("derives the kimi-code target from env HOME when KIMI_CODE_HOME is unset (sandbox-safe)", () => {
    const home = makeHome();
    const result = registerKimiHooksAllTargets({
      silent: true,
      nodeBin: "/usr/local/bin/node",
      env: { HOME: home, USERPROFILE: home },
    });
    assert.strictEqual(result.added, KIMI_HOOK_EVENTS.length * 2);
    assert.ok(fs.existsSync(path.join(home, ".kimi-code", "config.toml")));
  });

  it("unregister removes Clawd hooks from both paths", () => {
    const home = makeHome();
    const opts = { silent: true, nodeBin: "/usr/local/bin/node", env: env(home) };
    registerKimiHooksAllTargets(opts);
    const result = unregisterKimiHooksAllTargets({ silent: true, env: env(home) });
    assert.ok(result.removed >= 2);
    assert.ok(!fs.readFileSync(path.join(home, ".kimi", "config.toml"), "utf8").includes("kimi-hook.js"));
    assert.ok(!fs.readFileSync(path.join(home, ".kimi-code", "config.toml"), "utf8").includes("kimi-hook.js"));
  });

  it("reports a backup path for each modified config when backup is enabled", () => {
    const home = makeHome();
    const opts = { silent: true, nodeBin: "/usr/local/bin/node", env: env(home) };
    registerKimiHooksAllTargets(opts);
    const result = unregisterKimiHooksAllTargets({ silent: true, backup: true, env: env(home) });
    assert.ok(Array.isArray(result.backupPaths));
    assert.strictEqual(result.backupPaths.length, 2);
    for (const backupPath of result.backupPaths) {
      assert.ok(typeof backupPath === "string" && fs.existsSync(backupPath));
    }
  });
});

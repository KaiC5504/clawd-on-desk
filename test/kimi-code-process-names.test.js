const { describe, it } = require("node:test");
const assert = require("node:assert");
const kimi = require("../agents/kimi-cli");

// The new TypeScript "Kimi Code" CLI ships the SAME binary name as the old
// Python CLI — `kimi` (mac/linux) / `kimi.exe` (win) — just installed under
// ~/.kimi-code/ (verified: ~/.kimi-code/bin/kimi.exe runs as `kimi.exe`). So
// the existing process names already cover it; there is no separate
// `kimi-code` binary to detect. This guards against re-introducing one.
describe("Kimi adapter process names", () => {
  it("detects the kimi binary on every platform (covers both the old and new CLI)", () => {
    assert.ok(kimi.processNames.win.includes("kimi.exe"));
    assert.ok(kimi.processNames.mac.includes("kimi"));
    assert.ok(kimi.processNames.linux.includes("kimi"));
  });
});

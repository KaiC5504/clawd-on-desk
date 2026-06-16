"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  extractClaudeContextUsageFromEntries,
  resolveClaudeContextLimit,
} = require("../hooks/context-usage");

describe("Claude context usage parser", () => {
  it("extracts the latest assistant input usage with cache tokens", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-5",
          usage: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_read_input_tokens: 3000,
            cache_creation_input_tokens: 400,
          },
        },
      },
    ]);

    assert.deepStrictEqual(usage, {
      used: 4400,
      limit: 200000,
      percent: 2,
      source: "claude",
    });
  });

  it("excludes assistant output tokens to match Claude /context", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: {
          model: "claude-opus-4.7",
          usage: {
            input_tokens: 76578,
            output_tokens: 837,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);

    assert.deepStrictEqual(usage, {
      used: 76578,
      limit: 200000,
      percent: 38,
      source: "claude",
    });
  });

  it("uses a 1M limit for a real plain claude-opus-4-8 transcript entry", () => {
    // Real Claude Code transcripts record the plain resolved id (no [1m] suffix);
    // Claude Code strips the alias before the request. This is the case that shipped broken.
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 250000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);

    assert.deepStrictEqual(usage, {
      used: 250000,
      limit: 1000000,
      percent: 25,
      source: "claude",
    });
  });

  it("reports the originally-reported 43k symptom as ~4% of 1M, not 22% of 200k", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          usage: { input_tokens: 43000 },
        },
      },
    ]);

    assert.deepStrictEqual(usage, {
      used: 43000,
      limit: 1000000,
      percent: 4,
      source: "claude",
    });
  });

  it("still honors an explicit [1m] alias marker (belt-and-suspenders branch)", () => {
    assert.strictEqual(resolveClaudeContextLimit("claude-opus-4-8[1m]"), 1000000);
  });

  it("maps every verified 1M model family to a 1M limit", () => {
    for (const model of [
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-fable-5",
      "claude-mythos-5",
    ]) {
      assert.strictEqual(resolveClaudeContextLimit(model), 1000000, model);
    }
  });

  it("uses the latest usage entry from a transcript tail", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 1000 },
        },
      },
      {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 2000, cache_read_input_tokens: 1000 },
        },
      },
    ]);

    assert.deepStrictEqual(usage, {
      used: 3000,
      limit: 200000,
      percent: 2,
      source: "claude",
    });
  });

  it("skips sidechain sub-agent usage and falls back to the main-chain entry", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 150000 } },
      },
      {
        type: "assistant",
        isSidechain: true,
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 12000 } },
      },
    ], "sess-1");

    assert.deepStrictEqual(usage, {
      used: 150000,
      limit: 200000,
      percent: 75,
      source: "claude",
    });
  });

  it("ignores usage from a different session", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        sessionId: "sess-1",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 90000 } },
      },
      {
        type: "assistant",
        sessionId: "other",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 1000 } },
      },
    ], "sess-1");

    assert.deepStrictEqual(usage, {
      used: 90000,
      limit: 200000,
      percent: 45,
      source: "claude",
    });
  });

  it("skips API-error entries that carry a usage object", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 50000 } },
      },
      {
        type: "assistant",
        isApiErrorMessage: true,
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 999 } },
      },
    ], "sess-1");

    assert.deepStrictEqual(usage, {
      used: 50000,
      limit: 200000,
      percent: 25,
      source: "claude",
    });
  });

  it("counts entries without a sessionId field even when a session is given", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 8000 } },
      },
    ], "sess-1");

    assert.deepStrictEqual(usage, {
      used: 8000,
      limit: 200000,
      percent: 4,
      source: "claude",
    });
  });

  it("skips non-assistant entries that carry a usage object", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 50000 } },
      },
      {
        type: "summary",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 999 } },
      },
    ], "sess-1");

    assert.deepStrictEqual(usage, {
      used: 50000,
      limit: 200000,
      percent: 25,
      source: "claude",
    });
  });

  it("still counts a real-session entry when no session id is provided", () => {
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        sessionId: "real-uuid",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 2000 } },
      },
    ], null);

    assert.deepStrictEqual(usage, {
      used: 2000,
      limit: 200000,
      percent: 1,
      source: "claude",
    });
  });

  it("ignores entries without usage", () => {
    assert.strictEqual(extractClaudeContextUsageFromEntries([{ type: "user" }]), null);
  });

  it("returns raw used without percent for unknown model limits", () => {
    assert.strictEqual(resolveClaudeContextLimit("mystery-model"), null);
    const usage = extractClaudeContextUsageFromEntries([
      {
        type: "assistant",
        message: {
          model: "mystery-model",
          usage: { input_tokens: 123 },
        },
      },
    ]);

    assert.deepStrictEqual(usage, { used: 123, source: "claude" });
  });

  it("keeps genuine-200k Claude models at the 200k default", () => {
    for (const model of [
      "claude-opus-4-5",            // opus, but genuinely 200k — the tricky exclusion
      "claude-opus-4-1",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",          // 1M-capable on the API, but Claude Code runs it at 200k
      "claude-haiku-4-5-20251001",
    ]) {
      assert.strictEqual(resolveClaudeContextLimit(model), 200000, model);
    }
  });

  it("does not promote a hypothetical two-digit minor version to 1M", () => {
    // The (?![0-9]) anchor: opus-4-80 must not match the opus-4-8 allowlist entry
    // (it falls through to the opus 200k default)...
    assert.strictEqual(resolveClaudeContextLimit("claude-opus-4-80"), 200000);
    // ...while a real date-suffixed 1M id (next char is '-', not a digit) stays 1M.
    assert.strictEqual(resolveClaudeContextLimit("claude-opus-4-8-20260101"), 1000000);
  });

  it("returns null (no limit shown) for non-Claude / unknown model ids", () => {
    assert.strictEqual(resolveClaudeContextLimit("claude-2.0"), null); // pre-3.x 100k, no family token
    assert.strictEqual(resolveClaudeContextLimit("gpt-5"), null);
    assert.strictEqual(resolveClaudeContextLimit(""), 200000);         // empty -> existing default
  });

  it("forces 200k when CLAUDE_CODE_DISABLE_1M_CONTEXT=1 is set", () => {
    const prev = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
    try {
      assert.strictEqual(resolveClaudeContextLimit("claude-opus-4-8"), 200000);
      assert.strictEqual(resolveClaudeContextLimit("claude-opus-4-8[1m]"), 200000);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
      else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = prev;
    }
  });
});

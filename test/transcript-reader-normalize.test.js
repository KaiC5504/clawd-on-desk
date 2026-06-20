"use strict";

// Pure normalization core: entries -> view-model + tool_use<->tool_result join.
// No filesystem here; the I/O reader is exercised in transcript-reader-io.test.js.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  normalizeWindow,
  createJoinState,
  normalizeEntry,
} = require("../src/network/transcript-reader.js");

// ----- helpers -----

function assistant(content, extra = {}) {
  return {
    type: "assistant",
    uuid: extra.uuid || "a-uuid",
    timestamp: extra.timestamp || "2026-06-19T00:00:00Z",
    message: { role: "assistant", content },
    ...extra,
  };
}

function user(content, extra = {}) {
  return {
    type: "user",
    uuid: extra.uuid || "u-uuid",
    timestamp: extra.timestamp || "2026-06-19T00:00:01Z",
    message: { role: "user", content },
    ...extra,
  };
}

function toolUseBlock(id, name, input) {
  return { type: "tool_use", id, name, input: input || {} };
}

function toolResultBlock(toolUseId, content, isError) {
  const block = { type: "tool_result", tool_use_id: toolUseId, content };
  if (isError !== undefined) block.is_error = isError;
  return block;
}

function findBlock(entry, kind) {
  return entry.blocks.find((b) => b.kind === kind);
}

// ----- ALLOW set / type filtering -----

describe("type filtering (allow set)", () => {
  it("ignores non-user/non-assistant types entirely", () => {
    const raw = [
      { type: "system", uuid: "s1", content: "boot" },
      { type: "custom-title", uuid: "ct", customTitle: "My session" },
      { type: "summary", uuid: "sm", summary: "..." },
      { type: "future-unknown", uuid: "fu" },
    ];
    const { entries } = normalizeWindow(raw);
    assert.strictEqual(entries.length, 0);
  });

  it("emits user and assistant entries", () => {
    const { entries } = normalizeWindow([
      user("hello"),
      assistant([{ type: "text", text: "hi" }]),
    ]);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].role, "user");
    assert.strictEqual(entries[1].role, "assistant");
  });
});

// ----- user sub-classification -----

describe("user sub-classification", () => {
  it("drops isMeta user entries", () => {
    const { entries } = normalizeWindow([
      user("<command-name>compact</command-name>", { isMeta: true }),
    ]);
    assert.strictEqual(entries.length, 0);
  });

  it("emits a user bubble for a plain string prompt", () => {
    const { entries } = normalizeWindow([user("write a function")]);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].role, "user");
    const text = findBlock(entries[0], "text");
    assert.strictEqual(text.text, "write a function");
  });

  it("emits a user bubble for an array of text blocks", () => {
    const { entries } = normalizeWindow([
      user([{ type: "text", text: "part one" }, { type: "text", text: "part two" }]),
    ]);
    assert.strictEqual(entries.length, 1);
    const texts = entries[0].blocks.filter((b) => b.kind === "text").map((b) => b.text);
    assert.deepStrictEqual(texts, ["part one", "part two"]);
  });

  it("replaces an image block in user content with [image]", () => {
    const { entries } = normalizeWindow([
      user([
        { type: "text", text: "look at this" },
        { type: "image", source: { data: "BASE64BYTES" } },
      ]),
    ]);
    const texts = entries[0].blocks.filter((b) => b.kind === "text").map((b) => b.text);
    assert.deepStrictEqual(texts, ["look at this", "[image]"]);
  });

  it("emits NO user bubble when content carries only tool_result blocks", () => {
    const js = createJoinState();
    // register the pending tool_use first
    normalizeWindow([assistant([toolUseBlock("toolu_1", "Bash", { command: "ls" })])], js);
    const { entries } = normalizeWindow(
      [user([toolResultBlock("toolu_1", "file1\nfile2")])],
      js,
    );
    assert.strictEqual(entries.length, 0);
  });
});

// ----- assistant drops -----

describe("assistant drops", () => {
  it("drops isApiErrorMessage assistant entries", () => {
    const { entries } = normalizeWindow([
      assistant([{ type: "text", text: "boom" }], { isApiErrorMessage: true }),
    ]);
    assert.strictEqual(entries.length, 0);
  });

  it("drops subagent (isSidechain) assistant entries", () => {
    const { entries } = normalizeWindow([
      assistant([{ type: "text", text: "sub work" }], { isSidechain: true }),
    ]);
    assert.strictEqual(entries.length, 0);
  });

  it("drops <synthetic> model assistant entries", () => {
    const { entries } = normalizeWindow([
      assistant([{ type: "text", text: "x" }], { message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "x" }] } }),
    ]);
    assert.strictEqual(entries.length, 0);
  });
});

// ----- blocks within assistant -----

describe("assistant blocks", () => {
  it("reads thinking text from block.thinking, not block.text, and ignores signature", () => {
    const { entries } = normalizeWindow([
      assistant([
        { type: "thinking", thinking: "let me reason", signature: "sig-should-be-ignored", text: "WRONG" },
      ]),
    ]);
    const thinking = findBlock(entries[0], "thinking");
    assert.strictEqual(thinking.text, "let me reason");
    assert.ok(!JSON.stringify(entries[0]).includes("sig-should-be-ignored"));
    assert.ok(!JSON.stringify(entries[0]).includes("WRONG"));
  });

  it("aliases output_text -> text", () => {
    const { entries } = normalizeWindow([
      assistant([{ type: "output_text", text: "aliased" }]),
    ]);
    const text = findBlock(entries[0], "text");
    assert.strictEqual(text.text, "aliased");
  });

  it("aliases server_tool_use -> tool_use", () => {
    const { entries } = normalizeWindow([
      assistant([{ type: "server_tool_use", id: "srv_1", name: "WebSearch", input: { query: "x" } }]),
    ]);
    const tool = findBlock(entries[0], "tool_use");
    assert.ok(tool);
    assert.strictEqual(tool.name, "WebSearch");
    assert.strictEqual(tool.tool_use_id, "srv_1");
  });

  it("ignores unknown block types", () => {
    const { entries } = normalizeWindow([
      assistant([{ type: "redacted_thinking", data: "..." }, { type: "text", text: "kept" }]),
    ]);
    assert.strictEqual(entries[0].blocks.length, 1);
    assert.strictEqual(entries[0].blocks[0].kind, "text");
  });

  it("preserves text -> tool_use -> text ordering within one turn", () => {
    const { entries } = normalizeWindow([
      assistant([
        { type: "text", text: "before" },
        toolUseBlock("toolu_x", "Read", { file_path: "/a.txt" }),
        { type: "text", text: "after" },
      ]),
    ]);
    const kinds = entries[0].blocks.map((b) => b.kind);
    assert.deepStrictEqual(kinds, ["text", "tool_use", "text"]);
  });
});

// ----- the join -----

describe("tool_use <-> tool_result join", () => {
  it("paired use -> result in one window resolves the chip in place (no cross-window patch)", () => {
    const { entries, patches } = normalizeWindow([
      assistant([toolUseBlock("toolu_a", "Bash", { command: "echo hi" })]),
      user([toolResultBlock("toolu_a", "hi", false)]),
    ]);
    const chip = findBlock(entries[0], "tool_use");
    assert.strictEqual(chip.status, "done");
    assert.strictEqual(chip.meta.ok, true);
    assert.strictEqual(chip.output, "hi");
    // The chip is in this window, so it's patched in place — no separate patch.
    assert.strictEqual(patches.find((p) => p.tool_use_id === "toolu_a"), undefined);
  });

  it("in-flight tool_use with no result -> running", () => {
    const { entries } = normalizeWindow([
      assistant([toolUseBlock("toolu_b", "Bash", { command: "sleep 1" })]),
    ]);
    const chip = findBlock(entries[0], "tool_use");
    assert.strictEqual(chip.status, "running");
    assert.strictEqual(chip.output, undefined);
  });

  it("is_error true -> error status, ok false", () => {
    const { entries } = normalizeWindow([
      assistant([toolUseBlock("toolu_c", "Bash", { command: "false" })]),
      user([toolResultBlock("toolu_c", "command failed", true)]),
    ]);
    const chip = findBlock(entries[0], "tool_use");
    assert.strictEqual(chip.status, "error");
    assert.strictEqual(chip.meta.ok, false);
  });

  it("missing is_error => ok true", () => {
    const { entries } = normalizeWindow([
      assistant([toolUseBlock("toolu_d", "Bash", { command: "echo ok" })]),
      user([toolResultBlock("toolu_d", "ok")]),
    ]);
    const chip = findBlock(entries[0], "tool_use");
    assert.strictEqual(chip.meta.ok, true);
    assert.strictEqual(chip.status, "done");
  });

  it("orphan tool_result (unknown id) -> standalone chip, no crash", () => {
    const { entries } = normalizeWindow([
      user([toolResultBlock("toolu_unknown", "leftover output", false)]),
    ]);
    assert.strictEqual(entries.length, 1);
    const chip = findBlock(entries[0], "tool_use");
    assert.ok(chip);
    assert.strictEqual(chip.tool_use_id, "toolu_unknown");
    assert.strictEqual(chip.status, "done");
    assert.strictEqual(chip.output, "leftover output");
  });

  it("orphan tool_result derives a name from toolUseResult.type", () => {
    const raw = [
      {
        type: "user",
        uuid: "u-orphan",
        timestamp: "t",
        message: { role: "user", content: [toolResultBlock("toolu_z", "x", false)] },
        toolUseResult: { type: "Bash" },
      },
    ];
    const { entries } = normalizeWindow(raw);
    const chip = findBlock(entries[0], "tool_use");
    assert.strictEqual(chip.name, "Bash");
  });

  it("orphan tool_result with no type falls back to (tool)", () => {
    const { entries } = normalizeWindow([
      user([toolResultBlock("toolu_q", "x", false)]),
    ]);
    const chip = findBlock(entries[0], "tool_use");
    assert.strictEqual(chip.name, "(tool)");
  });

  it("handles multiple tool_results in one user entry, out of order", () => {
    const js = createJoinState();
    const a = normalizeWindow(
      [assistant([toolUseBlock("toolu_1", "Read", { file_path: "/a" }), toolUseBlock("toolu_2", "Read", { file_path: "/b" })])],
      js,
    );
    assert.strictEqual(a.entries[0].blocks.filter((b) => b.kind === "tool_use").length, 2);
    const r = normalizeWindow(
      [user([toolResultBlock("toolu_2", "B body"), toolResultBlock("toolu_1", "A body")])],
      js,
    );
    assert.strictEqual(r.entries.length, 0);
    const ids = r.patches.map((p) => p.tool_use_id).sort();
    assert.deepStrictEqual(ids, ["toolu_1", "toolu_2"]);
  });

  it("window-boundary: tool_use before slice still resolves (use earlier, result later)", () => {
    // single window with use then result far apart but in order
    const { entries } = normalizeWindow([
      assistant([toolUseBlock("toolu_e", "Bash", { command: "x" })]),
      assistant([{ type: "text", text: "thinking out loud" }]),
      user([toolResultBlock("toolu_e", "done body", false)]),
    ]);
    const chip = findBlock(entries[0], "tool_use");
    assert.strictEqual(chip.status, "done");
    assert.strictEqual(chip.output, "done body");
  });

  it("window-boundary: tool_use with no result in window stays running", () => {
    const { entries, joinState } = normalizeWindow([
      assistant([toolUseBlock("toolu_f", "Bash", { command: "x" })]),
    ]);
    const chip = findBlock(entries[0], "tool_use");
    assert.strictEqual(chip.status, "running");
    assert.ok(joinState.pendingToolUse.has("toolu_f"));
  });
});

// ----- meta derivation -----

describe("meta derivation", () => {
  it("derives meta.lines from toolUseResult.file.numLines (Read)", () => {
    const raw = [
      { type: "assistant", uuid: "a1", timestamp: "t", message: { role: "assistant", content: [toolUseBlock("toolu_r", "Read", { file_path: "/x" })] } },
      {
        type: "user",
        uuid: "u1",
        timestamp: "t",
        message: { role: "user", content: [toolResultBlock("toolu_r", [{ type: "text", text: "file body" }], false)] },
        toolUseResult: { type: "text", file: { numLines: 42 } },
      },
    ];
    const { entries } = normalizeWindow(raw);
    const chip = findBlock(entries[0], "tool_use");
    assert.strictEqual(chip.meta.lines, 42);
  });

  it("derives meta.lines from toolUseResult.numLines (Grep)", () => {
    const raw = [
      { type: "assistant", uuid: "a1", timestamp: "t", message: { role: "assistant", content: [toolUseBlock("toolu_g", "Grep", { pattern: "foo" })] } },
      {
        type: "user",
        uuid: "u1",
        timestamp: "t",
        message: { role: "user", content: [toolResultBlock("toolu_g", "match", false)] },
        toolUseResult: { numLines: 7 },
      },
    ];
    const { entries } = normalizeWindow(raw);
    const chip = findBlock(entries[0], "tool_use");
    assert.strictEqual(chip.meta.lines, 7);
  });

  it("derives meta.interrupted from toolUseResult.interrupted", () => {
    const raw = [
      { type: "assistant", uuid: "a1", timestamp: "t", message: { role: "assistant", content: [toolUseBlock("toolu_i", "Bash", { command: "x" })] } },
      {
        type: "user",
        uuid: "u1",
        timestamp: "t",
        message: { role: "user", content: [toolResultBlock("toolu_i", "partial", false)] },
        toolUseResult: { interrupted: true },
      },
    ];
    const { entries } = normalizeWindow(raw);
    const chip = findBlock(entries[0], "tool_use");
    assert.strictEqual(chip.meta.interrupted, true);
  });

  it("does NOT include an exit code in meta", () => {
    const raw = [
      { type: "assistant", uuid: "a1", timestamp: "t", message: { role: "assistant", content: [toolUseBlock("toolu_x", "Bash", { command: "x" })] } },
      {
        type: "user",
        uuid: "u1",
        timestamp: "t",
        message: { role: "user", content: [toolResultBlock("toolu_x", "out", false)] },
        toolUseResult: { exitCode: 1, returnCodeInterpretation: "failed" },
      },
    ];
    const { entries } = normalizeWindow(raw);
    const chip = findBlock(entries[0], "tool_use");
    assert.ok(!("exitCode" in chip.meta));
    assert.ok(!("code" in chip.meta));
  });

  it("does not crash when toolUseResult is a bare string (failure), yields an error chip", () => {
    const raw = [
      { type: "assistant", uuid: "a1", timestamp: "t", message: { role: "assistant", content: [toolUseBlock("toolu_s", "Bash", { command: "x" })] } },
      {
        type: "user",
        uuid: "u1",
        timestamp: "t",
        message: { role: "user", content: [toolResultBlock("toolu_s", "Error: boom", true)] },
        toolUseResult: "Error: boom",
      },
    ];
    const { entries } = normalizeWindow(raw);
    const chip = findBlock(entries[0], "tool_use");
    assert.strictEqual(chip.status, "error");
    assert.strictEqual(chip.meta.ok, false);
    assert.strictEqual(chip.meta.lines, undefined);
  });
});

// ----- target derivation + redaction -----

describe("target derivation", () => {
  it("Read/Edit/Write target = input.file_path", () => {
    const { entries } = normalizeWindow([
      assistant([toolUseBlock("t1", "Read", { file_path: "/home/me/notes.txt" })]),
    ]);
    assert.strictEqual(findBlock(entries[0], "tool_use").target, "/home/me/notes.txt");
  });

  it("Bash target = input.command, redacted", () => {
    const { entries } = normalizeWindow([
      assistant([toolUseBlock("t2", "Bash", { command: "curl -H 'authorization: Bearer abcdefghijklmnop' x" })]),
    ]);
    const target = findBlock(entries[0], "tool_use").target;
    assert.ok(target.includes("[redacted]"));
    assert.ok(!target.includes("abcdefghijklmnop"));
  });

  it("Grep target = input.pattern", () => {
    const { entries } = normalizeWindow([
      assistant([toolUseBlock("t3", "Grep", { pattern: "TODO" })]),
    ]);
    assert.strictEqual(findBlock(entries[0], "tool_use").target, "TODO");
  });

  it("omits target for tools without a recognised arg", () => {
    const { entries } = normalizeWindow([
      assistant([toolUseBlock("t4", "TodoWrite", { todos: [] })]),
    ]);
    assert.strictEqual(findBlock(entries[0], "tool_use").target, undefined);
  });
});

// ----- polymorphic tool_result content -----

describe("polymorphic tool_result content", () => {
  it("string content passes through as output", () => {
    const { entries } = normalizeWindow([
      assistant([toolUseBlock("p1", "Bash", { command: "x" })]),
      user([toolResultBlock("p1", "plain string out", false)]),
    ]);
    assert.strictEqual(findBlock(entries[0], "tool_use").output, "plain string out");
  });

  it("array-of-text content joins the text parts", () => {
    const { entries } = normalizeWindow([
      assistant([toolUseBlock("p2", "Read", { file_path: "/x" })]),
      user([toolResultBlock("p2", [{ type: "text", text: "line a" }, { type: "text", text: "line b" }], false)]),
    ]);
    const out = findBlock(entries[0], "tool_use").output;
    assert.ok(out.includes("line a"));
    assert.ok(out.includes("line b"));
  });

  it("array-with-image replaces image with [image]", () => {
    const { entries } = normalizeWindow([
      assistant([toolUseBlock("p3", "Read", { file_path: "/x.png" })]),
      user([toolResultBlock("p3", [{ type: "text", text: "see:" }, { type: "image", source: { data: "BYTES" } }], false)]),
    ]);
    const out = findBlock(entries[0], "tool_use").output;
    assert.ok(out.includes("[image]"));
    assert.ok(!out.includes("BYTES"));
  });
});

// ----- redaction of emitted text -----

describe("redaction", () => {
  it("redacts sk- token in assistant text", () => {
    const { entries } = normalizeWindow([
      assistant([{ type: "text", text: "the key is sk-FAKEabcdefghijklmnop1234567890 ok" }]),
    ]);
    const text = findBlock(entries[0], "text").text;
    assert.ok(text.includes("[redacted]"));
    assert.ok(!text.includes("sk-FAKE"));
  });

  it("redacts a PEM block in tool output", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nFAKEPEMBODY1234567890\n-----END RSA PRIVATE KEY-----";
    const { entries } = normalizeWindow([
      assistant([toolUseBlock("pem1", "Bash", { command: "cat key.pem" })]),
      user([toolResultBlock("pem1", pem, false)]),
    ]);
    const out = findBlock(entries[0], "tool_use").output;
    assert.ok(out.includes("[redacted]"));
    assert.ok(!out.includes("FAKEPEMBODY"));
  });

  it("redacts thinking text", () => {
    const { entries } = normalizeWindow([
      assistant([{ type: "thinking", thinking: "use token sk-FAKEabcdefghijklmnop1234567890" }]),
    ]);
    const text = findBlock(entries[0], "thinking").text;
    assert.ok(!text.includes("sk-FAKE"));
  });
});

// ----- view-model shape -----

describe("view-model shape", () => {
  it("entry carries uuid, cursor, role, at, blocks", () => {
    const { entries } = normalizeWindow([
      user("hi", { uuid: "real-uuid", timestamp: "2026-01-01T00:00:00Z" }),
    ]);
    const e = entries[0];
    assert.strictEqual(e.uuid, "real-uuid");
    assert.strictEqual(e.role, "user");
    assert.strictEqual(e.at, "2026-01-01T00:00:00Z");
    assert.ok(Array.isArray(e.blocks));
    assert.ok(typeof e.cursor === "string");
  });

  it("at is null when timestamp missing", () => {
    const raw = [{ type: "user", uuid: "u", message: { role: "user", content: "hi" } }];
    const { entries } = normalizeWindow(raw);
    assert.strictEqual(entries[0].at, null);
  });

  it("synthesizes a stable uuid from offset when uuid missing", () => {
    const raw = [{ type: "user", message: { role: "user", content: "hi" }, _offset: 1234 }];
    const { entries } = normalizeWindow(raw);
    assert.ok(typeof entries[0].uuid === "string");
    assert.ok(entries[0].uuid.length > 0);
  });
});

// ----- incremental join across calls (persistent JoinState) -----

describe("incremental join (persistent state)", () => {
  it("a running chip from one call is patched by a result in a later call", () => {
    const js = createJoinState();
    const first = normalizeWindow([assistant([toolUseBlock("inc1", "Bash", { command: "x" })])], js);
    assert.strictEqual(findBlock(first.entries[0], "tool_use").status, "running");
    assert.ok(js.pendingToolUse.has("inc1"));

    const second = normalizeWindow([user([toolResultBlock("inc1", "result body", false)])], js);
    assert.strictEqual(second.entries.length, 0);
    const patch = second.patches.find((p) => p.tool_use_id === "inc1");
    assert.ok(patch);
    assert.strictEqual(patch.status, "done");
    assert.strictEqual(patch.output, "result body");
    assert.ok(!js.pendingToolUse.has("inc1"));
  });
});

// ----- single-entry normalize export (for live deltas) -----

describe("normalizeEntry", () => {
  it("returns null for a dropped entry", () => {
    const js = createJoinState();
    const out = normalizeEntry({ type: "user", isMeta: true, message: { role: "user", content: "x" } }, js);
    assert.strictEqual(out.entry, null);
  });

  it("returns a patch list for a tool_result user entry", () => {
    const js = createJoinState();
    normalizeEntry({ type: "assistant", uuid: "a", message: { role: "assistant", content: [toolUseBlock("ne1", "Bash", { command: "x" })] } }, js);
    const out = normalizeEntry({ type: "user", uuid: "u", message: { role: "user", content: [toolResultBlock("ne1", "ok", false)] } }, js);
    assert.strictEqual(out.entry, null);
    assert.strictEqual(out.patches.length, 1);
    assert.strictEqual(out.patches[0].tool_use_id, "ne1");
  });
});

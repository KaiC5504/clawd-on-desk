"use strict";

// I/O reader: bounded tail reads, byte-offset bookkeeping, path-change/truncation
// handling, reverse paging. Uses hand-built fake JSONL in an OS temp dir only —
// never touches real ~/.claude.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createTranscriptReader } = require("../src/network/transcript-reader.js");

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-transcript-io-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

// Write an array of JS objects as JSONL; returns the absolute path.
function writeTmpJsonl(objs, name = "transcript.jsonl") {
  const file = path.join(tmpDir, name);
  const data = objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
  fs.writeFileSync(file, data);
  return file;
}

function appendJsonl(file, objs, { partial = false } = {}) {
  let data = objs.map((o) => JSON.stringify(o)).join("\n");
  if (!partial) data += "\n";
  fs.appendFileSync(file, data);
}

function uText(text, uuid) {
  return { type: "user", uuid, timestamp: "t", message: { role: "user", content: text } };
}

function aText(text, uuid) {
  return { type: "assistant", uuid, timestamp: "t", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function aToolUse(id, name, input, uuid) {
  return { type: "assistant", uuid, timestamp: "t", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } };
}

function uToolResult(id, content, uuid, isError) {
  const block = { type: "tool_result", tool_use_id: id, content };
  if (isError !== undefined) block.is_error = isError;
  return { type: "user", uuid, timestamp: "t", message: { role: "user", content: [block] } };
}

describe("snapshot", () => {
  it("returns entries and hasMore=false for a small file", () => {
    const file = writeTmpJsonl([uText("hi", "u1"), aText("hello", "a1")]);
    const reader = createTranscriptReader({ path: file });
    const snap = reader.snapshot();
    assert.strictEqual(snap.entries.length, 2);
    assert.strictEqual(snap.hasMore, false);
    reader.close();
  });

  it("returns at most maxEntries, slicing the tail", () => {
    const objs = [];
    for (let i = 0; i < 10; i++) objs.push(uText("msg" + i, "u" + i));
    const file = writeTmpJsonl(objs);
    const reader = createTranscriptReader({ path: file });
    const snap = reader.snapshot(3);
    assert.strictEqual(snap.entries.length, 3);
    // last 3 entries
    const texts = snap.entries.map((e) => e.blocks[0].text);
    assert.deepStrictEqual(texts, ["msg7", "msg8", "msg9"]);
    reader.close();
  });

  it("joins a tool_use just before the slice boundary", () => {
    // tool_use then padding then result; with small maxEntries the use is
    // before the slice but its result must still resolve to done.
    const objs = [
      aToolUse("toolu_pre", "Bash", { command: "x" }, "a0"),
      uText("pad1", "u1"),
      uText("pad2", "u2"),
      uToolResult("toolu_pre", "result body", "u3", false),
    ];
    const file = writeTmpJsonl(objs);
    const reader = createTranscriptReader({ path: file });
    const snap = reader.snapshot(2);
    // the tool_use entry itself may be sliced out, but the join ran over the
    // full window; ensure no crash and the slice is bounded
    assert.ok(snap.entries.length <= 2);
    reader.close();
  });

  it("sets hasMore=true when the tail read started past byte 0", () => {
    // Build a file large enough that a 256KB tail cannot reach the top.
    const objs = [];
    const filler = "x".repeat(4000);
    for (let i = 0; i < 100; i++) objs.push(uText(filler + i, "u" + i));
    const file = writeTmpJsonl(objs);
    const reader = createTranscriptReader({ path: file });
    const snap = reader.snapshot(5);
    assert.strictEqual(snap.hasMore, true);
    reader.close();
  });
});

describe("readDelta", () => {
  it("returns only new entries appended after snapshot", () => {
    const file = writeTmpJsonl([uText("first", "u1")]);
    const reader = createTranscriptReader({ path: file });
    reader.snapshot();

    appendJsonl(file, [aText("second", "a2")]);
    const delta = reader.readDelta(file);
    assert.strictEqual(delta.entries.length, 1);
    assert.strictEqual(delta.entries[0].blocks[0].text, "second");
    assert.strictEqual(delta.reset, false);
    reader.close();
  });

  it("returns a patch when a result for an earlier running chip arrives", () => {
    const file = writeTmpJsonl([aToolUse("toolu_d", "Bash", { command: "x" }, "a1")]);
    const reader = createTranscriptReader({ path: file });
    const snap = reader.snapshot();
    const chip = snap.entries[0].blocks.find((b) => b.kind === "tool_use");
    assert.strictEqual(chip.status, "running");

    appendJsonl(file, [uToolResult("toolu_d", "done out", "u2", false)]);
    const delta = reader.readDelta(file);
    assert.strictEqual(delta.entries.length, 0);
    const patch = delta.patches.find((p) => p.tool_use_id === "toolu_d");
    assert.ok(patch);
    assert.strictEqual(patch.status, "done");
    assert.strictEqual(patch.output, "done out");
    reader.close();
  });

  it("does not consume a trailing partial line until it is complete", () => {
    const file = writeTmpJsonl([uText("a", "u1")]);
    const reader = createTranscriptReader({ path: file });
    reader.snapshot();

    // append a partial line (no newline)
    appendJsonl(file, [aText("partial", "a2")], { partial: true });
    const d1 = reader.readDelta(file);
    assert.strictEqual(d1.entries.length, 0);

    // complete the line
    fs.appendFileSync(file, "\n");
    const d2 = reader.readDelta(file);
    assert.strictEqual(d2.entries.length, 1);
    assert.strictEqual(d2.entries[0].blocks[0].text, "partial");
    reader.close();
  });

  it("path-change -> reset snapshot against the new path", () => {
    const file1 = writeTmpJsonl([uText("old", "u1")], "old.jsonl");
    const reader = createTranscriptReader({ path: file1 });
    reader.snapshot();

    const file2 = writeTmpJsonl([uText("new1", "n1"), aText("new2", "n2")], "new.jsonl");
    const delta = reader.readDelta(file2);
    assert.strictEqual(delta.reset, true);
    assert.strictEqual(delta.entries.length, 2);
    assert.strictEqual(delta.entries[0].blocks[0].text, "new1");
    assert.deepStrictEqual(delta.patches, []);

    // subsequent deltas now track the new file
    appendJsonl(file2, [aText("new3", "n3")]);
    const d2 = reader.readDelta(file2);
    assert.strictEqual(d2.reset, false);
    assert.strictEqual(d2.entries.length, 1);
    assert.strictEqual(d2.entries[0].blocks[0].text, "new3");
    reader.close();
  });

  it("truncation (file shrank) -> reset snapshot", () => {
    const file = writeTmpJsonl([uText("a", "u1"), uText("b", "u2"), uText("c", "u3")]);
    const reader = createTranscriptReader({ path: file });
    reader.snapshot();

    // rewrite the file smaller than the held offset
    fs.writeFileSync(file, JSON.stringify(uText("fresh", "f1")) + "\n");
    const delta = reader.readDelta(file);
    assert.strictEqual(delta.reset, true);
    assert.strictEqual(delta.entries.length, 1);
    assert.strictEqual(delta.entries[0].blocks[0].text, "fresh");
    reader.close();
  });

  it("returns nothing new when nothing was appended", () => {
    const file = writeTmpJsonl([uText("a", "u1")]);
    const reader = createTranscriptReader({ path: file });
    reader.snapshot();
    const delta = reader.readDelta(file);
    assert.strictEqual(delta.entries.length, 0);
    assert.strictEqual(delta.patches.length, 0);
    assert.strictEqual(delta.reset, false);
    reader.close();
  });
});

describe("readOlder", () => {
  it("reverse-pages a chunk before the snapshot window", () => {
    const objs = [];
    const filler = "y".repeat(3000);
    for (let i = 0; i < 100; i++) objs.push(uText(filler + i, "u" + i));
    const file = writeTmpJsonl(objs);
    const reader = createTranscriptReader({ path: file });
    const snap = reader.snapshot(5);
    assert.strictEqual(snap.hasMore, true);

    const firstCursor = snap.entries[0].cursor;
    const older = reader.readOlder(firstCursor, 5);
    assert.ok(older.entries.length > 0);
    // older entries end strictly before the snapshot's first entry
    const olderLast = older.entries[older.entries.length - 1];
    assert.ok(olderLast.blocks[0].text < filler + "99");
    reader.close();
  });

  it("stops at the depth cap with hasMore=false", () => {
    // Build a very large file (> ~1MB) so paging hits the depth cap.
    const objs = [];
    const filler = "z".repeat(5000);
    for (let i = 0; i < 600; i++) objs.push(uText(filler + i, "u" + i));
    const file = writeTmpJsonl(objs);
    const reader = createTranscriptReader({ path: file });
    const snap = reader.snapshot(5);

    let cursor = snap.entries[0].cursor;
    let hasMore = snap.hasMore;
    let guard = 0;
    while (hasMore && guard < 50) {
      const older = reader.readOlder(cursor, 5);
      hasMore = older.hasMore;
      if (older.entries.length) cursor = older.entries[0].cursor;
      guard++;
    }
    // It must terminate (depth cap reached) rather than paging the whole file.
    assert.strictEqual(hasMore, false);
    assert.ok(guard < 50);
    reader.close();
  });
});

describe("multibyte byte-offset correctness", () => {
  it("keeps readDelta offsets exact when lines contain multibyte UTF-8", () => {
    // Emoji + CJK make each line longer in bytes than in chars; the byte-offset
    // bookkeeping must track file bytes, not char counts, or the delta drifts.
    const file = writeTmpJsonl([uText("héllo 世界 👋 first", "u1")]);
    const reader = createTranscriptReader({ path: file });
    reader.snapshot();
    appendJsonl(file, [aText("日本語 ✨ second", "a2")]);
    const delta = reader.readDelta(file);
    assert.strictEqual(delta.entries.length, 1);
    assert.strictEqual(delta.entries[0].blocks[0].text, "日本語 ✨ second");
    reader.close();
  });
});

describe("redaction through the reader", () => {
  it("redacts a secret in an appended assistant entry", () => {
    const file = writeTmpJsonl([uText("hi", "u1")]);
    const reader = createTranscriptReader({ path: file });
    reader.snapshot();
    appendJsonl(file, [aText("key sk-FAKEabcdefghijklmnop1234567890 end", "a2")]);
    const delta = reader.readDelta(file);
    const text = delta.entries[0].blocks[0].text;
    assert.ok(!text.includes("sk-FAKE"));
    assert.ok(text.includes("[redacted]"));
    reader.close();
  });
});

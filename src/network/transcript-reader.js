// src/network/transcript-reader.js — bounded reader over a Claude Code transcript
// .jsonl plus a pure normalization core that turns raw CC log lines into a clean
// chat view-model, resolving the tool_use<->tool_result join.
//
// Two layers, kept separate so the risky join logic is unit-testable without any
// filesystem:
//   1. Pure core: normalizeWindow / normalizeEntry over arrays of parsed objects.
//   2. I/O reader: createTranscriptReader does bounded tail reads + byte-offset
//      bookkeeping and drives the core.
//
// Gating, transport, coalescing and the tool-output pref live in the server (a
// later task); this module always populates redacted output when a result exists.

"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { redactSecrets } = require("../redact-secrets.js");

const TRANSCRIPT_TAIL_BYTES = 262144; // 256 KB per chunk — mirrors the hook cap.
const BACKWARD_DEPTH_CAP = 1048576; // ~1 MB total backward paging depth for v1.
const TOOL_OUTPUT_MAX = 4000; // head+tail clamp budget for coalesced tool output.
const OUTPUT_CONTROL_RE = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]+", "g");

// ----- pure normalization core -----

function createJoinState() {
  // pendingToolUse: tool_use_id -> { name } for chips awaiting a result.
  return { pendingToolUse: new Map() };
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

function entryMessageContent(entry) {
  const message = isObject(entry.message) ? entry.message : null;
  if (message && Object.prototype.hasOwnProperty.call(message, "content")) {
    return message.content;
  }
  return entry.content;
}

function looksSubagent(entry) {
  return entry.isSidechain === true
    || entry.isSubagent === true
    || entry.is_subagent === true
    || entry.subagent === true;
}

function entryModel(entry) {
  const message = isObject(entry.message) ? entry.message : null;
  if (message && typeof message.model === "string") return message.model;
  if (typeof entry.model === "string") return entry.model;
  return null;
}

// Clamp long text with a head+tail marker, mirroring the hook's
// clampAssistantOutputText shape so output stays bounded before redaction.
function clampText(text, maxLen = TOOL_OUTPUT_MAX) {
  const normalized = String(text)
    .replace(/\r\n?/g, "\n")
    .replace(OUTPUT_CONTROL_RE, " ");
  if (normalized.length <= maxLen) return normalized;
  const marker = "\n...[truncated]...\n";
  if (maxLen <= marker.length + 20) {
    return normalized.slice(normalized.length - maxLen);
  }
  const keep = maxLen - marker.length;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${normalized.slice(0, head)}${marker}${normalized.slice(normalized.length - tail)}`;
}

// Coalesce polymorphic tool_result content into one string. Image blocks become
// the literal "[image]"; raw image bytes are never inlined. Clamp BEFORE redact
// so the redactor sees the truncated text (cheaper, and the marker is benign).
function coalesceToolResultContent(content) {
  let raw;
  if (typeof content === "string") {
    raw = content;
  } else if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      if (!isObject(block)) continue;
      if (block.type === "image") {
        parts.push("[image]");
        continue;
      }
      if (typeof block.text === "string") parts.push(block.text);
    }
    raw = parts.join("\n");
  } else {
    raw = "";
  }
  return redactSecrets(clampText(raw));
}

// target = the human-meaningful arg for the tool, redacted. Bash commands carry
// secrets so the command string is redacted too.
function toolTarget(name, input) {
  if (!isObject(input)) return undefined;
  let value;
  if (name === "Read" || name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
    value = input.file_path;
  } else if (name === "Bash" || name === "BashOutput") {
    value = input.command;
  } else if (name === "Grep" || name === "Glob") {
    value = input.pattern;
  }
  if (typeof value !== "string" || !value) return undefined;
  return redactSecrets(value);
}

function makeTextBlock(text) {
  return { kind: "text", text: redactSecrets(String(text)) };
}

// Build the tool_use chip for an assistant block and register it as pending.
function makeToolUseBlock(block, joinState) {
  const id = typeof block.id === "string" ? block.id : null;
  const name = typeof block.name === "string" && block.name ? block.name : "(tool)";
  const chip = { kind: "tool_use", tool_use_id: id, name, status: "running", meta: {} };
  const target = toolTarget(name, block.input);
  if (target !== undefined) chip.target = target;
  if (id) joinState.pendingToolUse.set(id, { name });
  return chip;
}

// Derive { status, meta, output } from a tool_result block + its structured
// sibling toolUseResult. toolUseResult may be a bare string on failure — guard
// every nested access.
function resultPatchFields(resultBlock, toolUseResult) {
  const isError = resultBlock.is_error === true;
  const meta = { ok: !isError };

  if (isObject(toolUseResult)) {
    if (toolUseResult.interrupted === true) meta.interrupted = true;
    const fileLines = isObject(toolUseResult.file) ? toolUseResult.file.numLines : undefined;
    if (typeof fileLines === "number") {
      meta.lines = fileLines;
    } else if (typeof toolUseResult.numLines === "number") {
      meta.lines = toolUseResult.numLines;
    }
  }

  const output = coalesceToolResultContent(resultBlock.content);
  return { status: isError ? "error" : "done", meta, output };
}

// Process a user entry's tool_result blocks: patch pending chips, or emit a
// standalone orphan chip when the tool_use is outside the window/map.
// Returns { patches, orphanBlocks }.
function processToolResults(entry, resultBlocks, joinState) {
  const toolUseResult = entry.toolUseResult;
  const patches = [];
  const orphanBlocks = [];

  for (const block of resultBlocks) {
    const id = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
    const fields = resultPatchFields(block, toolUseResult);

    if (id && joinState.pendingToolUse.has(id)) {
      joinState.pendingToolUse.delete(id);
      patches.push({
        tool_use_id: id,
        status: fields.status,
        meta: fields.meta,
        output: fields.output,
      });
      continue;
    }

    // Orphan: no matching tool_use in this window. Render a standalone chip from
    // the result alone so the output is not lost. Name from toolUseResult.type.
    const name = isObject(toolUseResult) && typeof toolUseResult.type === "string" && toolUseResult.type
      ? toolUseResult.type
      : "(tool)";
    orphanBlocks.push({
      kind: "tool_use",
      tool_use_id: id,
      name,
      status: fields.status,
      meta: fields.meta,
      output: fields.output,
    });
  }

  return { patches, orphanBlocks };
}

function blockKindFromType(type) {
  if (type === "output_text") return "text";
  if (type === "server_tool_use") return "tool_use";
  return type;
}

// Normalize a single assistant entry's content array into view blocks, in order.
function assistantBlocks(content, joinState) {
  if (typeof content === "string") return content ? [makeTextBlock(content)] : [];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    const kind = blockKindFromType(typeof block.type === "string" ? block.type : "");
    if (kind === "text") {
      if (typeof block.text === "string") blocks.push(makeTextBlock(block.text));
    } else if (kind === "thinking") {
      // thinking text lives on block.thinking; block.signature is ignored.
      if (typeof block.thinking === "string") {
        blocks.push({ kind: "thinking", text: redactSecrets(block.thinking) });
      }
    } else if (kind === "tool_use") {
      blocks.push(makeToolUseBlock(block, joinState));
    }
    // other block types (redacted_thinking, etc.) are ignored.
  }
  return blocks;
}

// Normalize user prompt content into text/image view blocks. Image blocks become
// the literal "[image]" text block.
function userPromptBlocks(content) {
  if (typeof content === "string") return content ? [makeTextBlock(content)] : [];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const block of content) {
    if (typeof block === "string") {
      blocks.push(makeTextBlock(block));
      continue;
    }
    if (!isObject(block)) continue;
    if (block.type === "image") {
      blocks.push({ kind: "text", text: "[image]" });
      continue;
    }
    if (typeof block.text === "string") blocks.push(makeTextBlock(block.text));
  }
  return blocks;
}

function cursorFromOffset(offset) {
  const safe = Math.max(0, Math.trunc(Number(offset) || 0));
  return Buffer.from(String(safe), "utf8").toString("base64");
}

function offsetFromCursor(cursor) {
  try {
    const decoded = Buffer.from(String(cursor), "base64").toString("utf8");
    const n = Number.parseInt(decoded, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function entryUuid(entry, offset) {
  if (typeof entry.uuid === "string" && entry.uuid) return entry.uuid;
  // Synthesize a stable id from the byte offset so the same line always maps to
  // the same client identity across reads.
  const seed = typeof offset === "number" ? offset : entry._offset;
  return `syn-${crypto.createHash("sha1").update(String(seed)).digest("hex").slice(0, 16)}`;
}

// Normalize ONE raw entry. Returns { entry, patches }: entry is the view-model
// entry (or null if dropped / it only carried tool_results), patches are
// tool-result patches for previously-running chips.
function normalizeEntry(raw, joinState) {
  const empty = { entry: null, patches: [] };
  if (!isObject(raw)) return empty;
  const type = raw.type;
  if (type !== "user" && type !== "assistant") return empty;

  const offset = typeof raw._offset === "number" ? raw._offset : 0;
  const at = typeof raw.timestamp === "string" ? raw.timestamp : null;
  const content = entryMessageContent(raw);

  if (type === "user") {
    if (raw.isMeta === true) return empty; // CC-injected command/caveat prelude.

    const resultBlocks = Array.isArray(content)
      ? content.filter((b) => isObject(b) && b.type === "tool_result")
      : [];

    if (resultBlocks.length > 0) {
      const { patches, orphanBlocks } = processToolResults(raw, resultBlocks, joinState);
      if (orphanBlocks.length > 0) {
        return {
          entry: {
            uuid: entryUuid(raw, offset),
            cursor: cursorFromOffset(offset),
            role: "user",
            at,
            blocks: orphanBlocks,
          },
          patches,
        };
      }
      // Pure tool_result carrier — emit no user bubble.
      return { entry: null, patches };
    }

    const blocks = userPromptBlocks(content);
    if (blocks.length === 0) return empty;
    return {
      entry: { uuid: entryUuid(raw, offset), cursor: cursorFromOffset(offset), role: "user", at, blocks },
      patches: [],
    };
  }

  // assistant
  if (raw.isApiErrorMessage === true) return empty;
  if (entryModel(raw) === "<synthetic>") return empty;
  if (looksSubagent(raw)) return empty;

  const blocks = assistantBlocks(content, joinState);
  if (blocks.length === 0) return empty;
  return {
    entry: { uuid: entryUuid(raw, offset), cursor: cursorFromOffset(offset), role: "assistant", at, blocks },
    patches: [],
  };
}

// Apply patches onto already-emitted chips within the same set of entries so a
// resolved tool_use chip shows its final status instead of "running". Returns
// the set of tool_use_ids that matched an in-window chip.
function applyPatchesToEntries(entries, patches) {
  const applied = new Set();
  if (!patches.length) return applied;
  const byId = new Map(patches.map((p) => [p.tool_use_id, p]));
  for (const entry of entries) {
    for (const block of entry.blocks) {
      if (block.kind !== "tool_use" || !block.tool_use_id) continue;
      const patch = byId.get(block.tool_use_id);
      if (!patch) continue;
      block.status = patch.status;
      block.meta = patch.meta;
      if (patch.output !== undefined) block.output = patch.output;
      applied.add(block.tool_use_id);
    }
  }
  return applied;
}

// normalizeWindow: run the join over a whole window of raw entries (file order).
// Resolved chips are patched in place so the window is internally consistent;
// only patches whose chip is NOT in this window (an earlier delta's running chip)
// are returned, so the caller can apply them to previously-sent entries.
function normalizeWindow(rawEntries, joinState = createJoinState()) {
  const entries = [];
  const allPatches = [];
  for (const raw of rawEntries) {
    const { entry, patches: p } = normalizeEntry(raw, joinState);
    if (entry) entries.push(entry);
    if (p.length) allPatches.push(...p);
  }
  const appliedInWindow = applyPatchesToEntries(entries, allPatches);
  const patches = allPatches.filter((p) => !appliedInWindow.has(p.tool_use_id));
  return { entries, patches, joinState };
}

// ----- I/O reader -----

// Read [start, end) of a file into a Buffer. Returns an empty Buffer on error.
// A Buffer (not a string) is returned so line splitting and byte-offset math are
// exact even when a tail boundary splits a multibyte UTF-8 character.
function readByteRange(path, start, end) {
  const len = end - start;
  if (len <= 0) return Buffer.alloc(0);
  let fd = null;
  try {
    fd = fs.openSync(path, "r");
    const buf = Buffer.alloc(len);
    const got = fs.readSync(fd, buf, 0, len, start);
    return got === len ? buf : buf.subarray(0, got);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

const NEWLINE = 0x0a;

// Parse complete JSONL lines from a Buffer covering [windowStart, end). Splits on
// raw newline BYTES so each object's _offset and the returned lastConsumedEnd are
// true file byte offsets — a multibyte char split at the window start cannot drift
// them. If dropTorn is true (window does not begin at byte 0), the first line is
// assumed truncated and dropped. A trailing partial line (no terminating newline)
// is never consumed: lastConsumedEnd stops at the last complete line's newline.
function parseLinesWithOffsets(buf, windowStart, dropTorn) {
  const parsed = [];
  let lineStart = 0; // byte index within buf
  let lastConsumedEnd = windowStart;
  let first = true;

  let nl = buf.indexOf(NEWLINE);
  while (nl !== -1) {
    if (first && dropTorn) {
      // torn opening line — discard, but advance consumption past it.
    } else {
      const line = buf.toString("utf8", lineStart, nl);
      if (line.trim()) {
        try {
          const obj = JSON.parse(line);
          if (isObject(obj)) {
            obj._offset = windowStart + lineStart;
            parsed.push(obj);
          }
        } catch {
          // drop unparseable line
        }
      }
    }

    first = false;
    lastConsumedEnd = windowStart + nl + 1;
    lineStart = nl + 1;
    nl = buf.indexOf(NEWLINE, lineStart);
  }

  return { parsed, lastConsumedEnd };
}

function fileSize(path) {
  try {
    return fs.statSync(path).size;
  } catch {
    return -1;
  }
}

function createTranscriptReader({ path }) {
  const creationPath = path;
  let heldPath = path;
  let heldOffset = 0; // forward EOF byte offset; bytes < this are consumed.
  let joinState = createJoinState();
  let reading = false; // in-flight guard for readDelta.

  // Bounded tail read of the last <=256 KB; run the join over the FULL window
  // first, then slice to the last maxEntries so a tool_use just before the slice
  // still resolves its result.
  function buildSnapshot(maxEntries) {
    const size = fileSize(heldPath);
    if (size < 0) {
      heldOffset = 0;
      return { entries: [], hasMore: false };
    }
    const windowStart = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const buf = readByteRange(heldPath, windowStart, size);
    const { parsed, lastConsumedEnd } = parseLinesWithOffsets(buf, windowStart, windowStart > 0);

    // normalizeWindow already resolved in-window chips; any returned patches are
    // cross-window orphans we cannot attach here, so they are dropped.
    const { entries } = normalizeWindow(parsed, joinState);

    heldOffset = lastConsumedEnd;

    const sliced = entries.slice(Math.max(0, entries.length - maxEntries));
    const hasMore = windowStart > 0;
    return { entries: sliced, hasMore };
  }

  function snapshot(maxEntries = 50) {
    joinState = createJoinState(); // re-init so live deltas continue this window.
    return buildSnapshot(maxEntries);
  }

  function freshReset() {
    joinState = createJoinState();
    const snap = buildSnapshot(50);
    return { entries: snap.entries, patches: [], reset: true };
  }

  function readDelta(currentPath) {
    if (reading) return { entries: [], patches: [], reset: false };
    reading = true;
    try {
      // Path change: CC /resume or auto-compact writes a NEW .jsonl. Re-open
      // against it and rebuild from scratch.
      if (typeof currentPath === "string" && currentPath && currentPath !== heldPath) {
        heldPath = currentPath;
        return freshReset();
      }

      const size = fileSize(heldPath);
      if (size < 0) return { entries: [], patches: [], reset: false };

      // Truncation / inode reuse: file shrank below what we have consumed.
      if (size < heldOffset) {
        return freshReset();
      }

      if (size === heldOffset) return { entries: [], patches: [], reset: false };

      const buf = readByteRange(heldPath, heldOffset, size);
      const { parsed, lastConsumedEnd } = parseLinesWithOffsets(buf, heldOffset, false);
      heldOffset = lastConsumedEnd;

      const { entries, patches } = normalizeWindow(parsed, joinState);
      return { entries, patches, reset: false };
    } finally {
      reading = false;
    }
  }

  // Reverse-read ONE bounded chunk ending just before the cursor offset. Cap
  // total backward depth at ~1 MB from EOF; once past it, stop (hasMore false).
  function readOlder(beforeCursor, count = 50) {
    const before = offsetFromCursor(beforeCursor);
    if (before <= 0) return { entries: [], hasMore: false };

    const size = fileSize(heldPath);
    if (size < 0) return { entries: [], hasMore: false };

    const depthFloor = Math.max(0, size - BACKWARD_DEPTH_CAP);
    if (before <= depthFloor) return { entries: [], hasMore: false };

    const windowStart = Math.max(depthFloor, before - TRANSCRIPT_TAIL_BYTES);
    const buf = readByteRange(heldPath, windowStart, before);
    // The chunk's own join is self-contained; do not touch the live joinState.
    const { parsed } = parseLinesWithOffsets(buf, windowStart, windowStart > 0);

    const localState = createJoinState();
    const { entries } = normalizeWindow(parsed, localState);

    const sliced = entries.slice(Math.max(0, entries.length - count));
    const hasMore = windowStart > 0 && windowStart > depthFloor;
    return { entries: sliced, hasMore };
  }

  function close() {
    // No persistent fd is held (statSync/readSync per call). Reset state.
    joinState = createJoinState();
    reading = false;
  }

  return { snapshot, readDelta, readOlder, close, get path() { return creationPath; } };
}

module.exports = {
  createTranscriptReader,
  normalizeWindow,
  normalizeEntry,
  createJoinState,
};

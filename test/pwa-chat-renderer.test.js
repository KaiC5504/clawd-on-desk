"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "pwa");
const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "style.css"), "utf8");
const i18n = require("../pwa/i18n.js");

// Isolate the ChatRenderer class body so "uses appendChild / never re-innerHTMLs"
// assertions don't accidentally match other renderers.
function classBody(src, name) {
  const start = src.indexOf("class " + name);
  assert.ok(start !== -1, name + " class must exist");
  // Walk braces from the first "{" after the class name to its matching close.
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error("unbalanced braces in " + name);
}
const CHAT = classBody(app, "ChatRenderer");

describe("pwa chat renderer — class + container reuse", () => {
  it("defines a ChatRenderer class that does NOT extend DetailRenderer", () => {
    assert.match(app, /class ChatRenderer\s*\{/);
    assert.doesNotMatch(app, /class ChatRenderer\s+extends/);
  });

  it("reuses the #detail-overlay container (mutually exclusive with the detail screen)", () => {
    assert.match(app, /this\.chat = new ChatRenderer\(document\.getElementById\("detail-overlay"\)/);
  });

  it("is constructed with a send callback", () => {
    assert.match(app, /new ChatRenderer\(document\.getElementById\("detail-overlay"\), \{[\s\S]*?send:/);
  });
});

describe("pwa chat renderer — tap routing branches on hasTranscript", () => {
  it("opens the chat + subscribes when the session has a transcript", () => {
    assert.match(app, /if \(session && session\.hasTranscript\)/);
    assert.match(app, /self\.chat\.open\(sid\)/);
    assert.match(app, /type: "subscribe_transcript", sessionId: sid/);
  });

  it("falls back to the detail screen + request_detail otherwise", () => {
    assert.match(app, /self\.detail\.open\(sid\)/);
    assert.match(app, /type: "request_detail", sessionId: sid/);
  });
});

describe("pwa chat renderer — onMessage routing", () => {
  const types = [
    "transcript_snapshot",
    "transcript_delta",
    "transcript_result_patch",
    "transcript_older",
    "transcript_unavailable",
  ];

  for (const ty of types) {
    it(`handles ${ty} and early-returns on a sessionId mismatch`, () => {
      const re = new RegExp(
        'msg\\.type === "' + ty + '"[^}]*?if \\(msg\\.sessionId !== self\\.chat\\.sessionId\\) return;'
      );
      assert.match(app, re, `${ty} handler must early-return on a stale sessionId`);
    });
  }

  it("removes the orphan tool_output consumer (no producer in src/)", () => {
    assert.doesNotMatch(app, /msg\.type === "tool_output"/);
  });

  it("re-subscribes the chat on WS reconnect (onOpen) so the live view doesn't freeze", () => {
    const onOpen = app.match(/this\.connection\.onOpen = function\(\) \{[\s\S]*?\n {6}\};/)?.[0] || "";
    assert.ok(onOpen, "onOpen handler must exist");
    assert.match(onOpen, /self\.chat\.isOpen\(\)/);
    assert.match(onOpen, /type: "subscribe_transcript", sessionId: self\.chat\.sessionId/);
  });
});

describe("pwa chat renderer — snapshot rebuilds once, deltas append, older prepends", () => {
  it("snapshot path may innerHTML the shell once but delta path never re-innerHTMLs the body", () => {
    const snap = CHAT.match(/onSnapshot\([\s\S]*?\n {4}\}/)?.[0] || "";
    const delta = CHAT.match(/onDelta\([\s\S]*?\n {4}\}/)?.[0] || "";
    assert.ok(snap, "onSnapshot must exist");
    assert.ok(delta, "onDelta must exist");
    // The delta path is the perf cliff: it must appendChild, never blow away the body.
    assert.match(delta, /appendChild/);
    assert.doesNotMatch(delta, /\.innerHTML\s*=/);
  });

  it("older entries are inserted before existing ones (prepend), not appended", () => {
    const older = CHAT.match(/onOlder\([\s\S]*?\n {4}\}/)?.[0] || "";
    assert.ok(older, "onOlder must exist");
    assert.match(older, /insertBefore/);
    // Preserve scroll position across a prepend.
    assert.match(older, /scrollHeight/);
    assert.match(older, /scrollTop/);
  });
});

describe("pwa chat renderer — bubble + block rendering", () => {
  it("assistant text goes through mdToHtml with the approval-md class", () => {
    assert.match(CHAT, /chat-text approval-md/);
    assert.match(CHAT, /mdToHtml\(b\.text \|\| ""\)/);
  });

  it("user text is escaped (plain), never markdown", () => {
    assert.match(CHAT, /esc\(b\.text \|\| ""\)/);
  });

  it("user vs assistant bubbles get distinct classes", () => {
    assert.match(CHAT, /chat-msg-user/);
    assert.match(CHAT, /chat-msg-assistant/);
  });

  it("tool chip carries data-tool-use-id and is patched by transcript_result_patch", () => {
    assert.match(CHAT, /data-tool-use-id="/);
    assert.match(CHAT, /onResultPatch\(msg\)/);
    assert.match(CHAT, /\.chat-tool-chip\[data-tool-use-id=/);
  });

  it("the output dropdown is gated by toolOutput (hidden text when off)", () => {
    assert.match(CHAT, /this\.toolOutput/);
    assert.match(CHAT, /t\("chat_tool_output_hidden"\)/);
  });

  it("thinking renders as a collapsed disclosure", () => {
    assert.match(CHAT, /<details class="chat-thinking">/);
    assert.match(CHAT, /t\("chat_thinking"\)/);
  });

  it("tool-chip meta labels come from t() (no hardcoded English)", () => {
    const meta = CHAT.match(/_chipMeta\(status, meta\) \{[\s\S]*?\n {4}\}/)?.[0] || "";
    assert.ok(meta, "_chipMeta must exist");
    assert.match(meta, /t\("chat_meta_interrupted"\)/);
    assert.match(meta, /t\("chat_meta_failed"\)/);
    assert.match(meta, /t\("chat_meta_ok_lines", \{ n: meta\.lines \}\)/);
    assert.match(meta, /t\("chat_meta_ok"\)/);
    // The previously-hardcoded English phrasings must be gone from the method.
    assert.doesNotMatch(meta, /"failed"|"interrupted"|ok · /);
  });
});

describe("pwa chat renderer — dedupe + live UX + states", () => {
  it("dedupes entries by uuid", () => {
    assert.match(CHAT, /this\.seen\.has\(entry\.uuid\)/);
    assert.match(CHAT, /this\.seen\.add\(entry\.uuid\)/);
  });

  it("keeps a sticky auto-scroll with a jump-to-latest chip", () => {
    assert.match(CHAT, /chat-jump-latest/);
    assert.match(CHAT, /t\("chat_jump_latest"\)/);
    assert.match(CHAT, /_atBottom\(\)/);
  });

  it("requests older entries with the oldest cursor and count 50", () => {
    assert.match(CHAT, /type: "request_older_transcript"/);
    assert.match(CHAT, /count: 50/);
  });

  it("caps the DOM at ~800 entries (no virtual scroll)", () => {
    assert.match(app, /CHAT_MAX_ENTRIES = 800/);
    assert.match(CHAT, /_trimToCap\(\)/);
  });

  it("insecure → secure notice; disabled/not-allowed/no-path → detail fallback", () => {
    assert.match(CHAT, /reason === "insecure"/);
    assert.match(CHAT, /t\("chat_unavailable_insecure"\)/);
    assert.match(CHAT, /this\.onFallback/);
  });

  it("close() unsubscribes; the fallback close does NOT re-subscribe", () => {
    assert.match(CHAT, /type: "unsubscribe_transcript"/);
    const unavail = CHAT.match(/onUnavailable\([\s\S]*?\n {4}\}/)?.[0] || "";
    assert.ok(unavail, "onUnavailable must exist");
    assert.doesNotMatch(unavail, /unsubscribe_transcript/);
  });
});

describe("pwa chat renderer — CSS uses tokens only", () => {
  const selectors = [
    ".chat-header", ".chat-body", ".chat-msg-user", ".chat-msg-assistant",
    ".chat-tool-chip", ".chat-tool-output", ".chat-thinking", ".chat-jump-latest",
  ];
  for (const sel of selectors) {
    it(`defines a ${sel} rule`, () => {
      assert.ok(css.includes(sel), `${sel} must be defined in style.css`);
    });
  }

  it("chat bubble rules avoid hardcoded hex colors (tokens only)", () => {
    // White text on the accent chip and a shadow are the only allowed literals,
    // matching the existing .detail-focus-btn / toast conventions.
    const rules = (css.match(/\.chat-msg[^{]*\{[^}]*\}/g) || []).join("\n");
    assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,6}/, "chat bubbles must use design tokens");
  });
});

describe("pwa chat renderer — i18n keys present for every language", () => {
  const keys = [
    "chat_loading", "chat_load_older", "chat_jump_latest", "chat_thinking",
    "chat_tool_output_hidden", "chat_you", "chat_empty",
    "chat_unavailable_disabled", "chat_unavailable_not_allowed", "chat_unavailable_insecure",
    "chat_meta_ok", "chat_meta_ok_lines", "chat_meta_failed", "chat_meta_interrupted",
  ];
  for (const key of keys) {
    it(`${key} exists for all 5 languages`, () => {
      const entry = i18n.I18N[key];
      assert.ok(entry, `${key} must exist`);
      for (const lang of i18n.SUPPORTED_LANGS) {
        assert.strictEqual(typeof entry[lang], "string", `${key}.${lang} must be a string`);
        assert.ok(entry[lang].length > 0, `${key}.${lang} must be non-empty`);
      }
    });
  }
});

describe("pwa chat renderer — reuses existing icons (no new glyphs needed)", () => {
  it("uses messageCircle, tool, and arrowLeft", () => {
    assert.match(CHAT, /icon\("messageCircle"\)/);
    assert.match(CHAT, /icon\("tool"\)/);
    assert.match(CHAT, /icon\("arrowLeft"\)/);
  });
});

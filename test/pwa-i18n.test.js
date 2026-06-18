"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const i18n = require("../pwa/i18n.js");

describe("pwa i18n — dictionary completeness", () => {
  it("supports exactly the five desktop languages", () => {
    assert.deepStrictEqual(i18n.SUPPORTED_LANGS, ["en", "zh", "zh-TW", "ko", "ja"]);
  });

  it("every key has all 5 languages as non-empty strings", () => {
    const keys = Object.keys(i18n.I18N);
    assert.ok(keys.length > 0, "dictionary should not be empty");
    for (const key of keys) {
      const entry = i18n.I18N[key];
      for (const lang of i18n.SUPPORTED_LANGS) {
        assert.strictEqual(typeof entry[lang], "string", `${key}.${lang} should be a string`);
        assert.ok(entry[lang].length > 0, `${key}.${lang} should be non-empty`);
      }
    }
  });

  it("placeholders are identical across every language for each key", () => {
    const placeholders = (s) => (s.match(/\{(\w+)\}/g) || []).slice().sort().join(",");
    for (const key of Object.keys(i18n.I18N)) {
      const entry = i18n.I18N[key];
      const ref = placeholders(entry.en);
      for (const lang of i18n.SUPPORTED_LANGS) {
        assert.strictEqual(placeholders(entry[lang]), ref,
          `${key}.${lang} placeholders must match en ("${ref}")`);
      }
    }
  });

  it("LANG_NATIVE_NAMES covers every supported language", () => {
    for (const lang of i18n.SUPPORTED_LANGS) {
      assert.strictEqual(typeof i18n.LANG_NATIVE_NAMES[lang], "string");
      assert.ok(i18n.LANG_NATIVE_NAMES[lang].length > 0);
    }
  });
});

describe("pwa i18n — mapNavigatorLang", () => {
  const cases = [
    ["zh-CN", "zh"], ["zh", "zh"], ["zh-Hans", "zh"],
    ["zh-TW", "zh-TW"], ["zh-HK", "zh-TW"], ["zh-Hant", "zh-TW"],
    ["ko-KR", "ko"], ["ko", "ko"],
    ["ja-JP", "ja"], ["ja", "ja"],
    ["en-US", "en"], ["en", "en"],
    ["fr-FR", null], ["", null], [null, null],
  ];
  for (const [input, expected] of cases) {
    it(`maps ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      assert.strictEqual(i18n.mapNavigatorLang(input), expected);
    });
  }
});

describe("pwa i18n — resolveLang precedence (override > desktop > navigator > en)", () => {
  it("override wins when supported", () => {
    assert.strictEqual(i18n.resolveLang({ override: "ja", desktop: "zh", navigatorLang: "en-US" }), "ja");
  });
  it("ignores an unsupported override and falls to desktop", () => {
    assert.strictEqual(i18n.resolveLang({ override: "xx", desktop: "ko", navigatorLang: "en-US" }), "ko");
  });
  it("desktop wins over navigator", () => {
    assert.strictEqual(i18n.resolveLang({ desktop: "zh-TW", navigatorLang: "ja-JP" }), "zh-TW");
  });
  it("ignores an unsupported desktop value and falls to navigator", () => {
    assert.strictEqual(i18n.resolveLang({ desktop: "klingon", navigatorLang: "ja-JP" }), "ja");
  });
  it("falls back to navigator, then to en", () => {
    assert.strictEqual(i18n.resolveLang({ navigatorLang: "ko" }), "ko");
    assert.strictEqual(i18n.resolveLang({ navigatorLang: "fr" }), "en");
    assert.strictEqual(i18n.resolveLang({}), "en");
  });
});

describe("pwa i18n — t() translation + interpolation", () => {
  it("returns the value for the active language", () => {
    i18n.setLang("ja", { transient: true });
    assert.strictEqual(i18n.t("approval_allow"), "許可");
    i18n.setLang("zh-TW", { transient: true });
    assert.strictEqual(i18n.t("approval_allow"), "允許");
    i18n.setLang("en", { transient: true });
  });
  it("returns the key itself for an unknown key", () => {
    assert.strictEqual(i18n.t("____nope____"), "____nope____");
  });
  it("interpolates named placeholders", () => {
    i18n.setLang("en", { transient: true });
    assert.strictEqual(i18n.t("time_min_ago", { n: 5 }), "5m ago");
    i18n.setLang("ja", { transient: true });
    assert.strictEqual(i18n.t("time_min_ago", { n: 5 }), "5分前");
    i18n.setLang("en", { transient: true });
  });
});

describe("pwa i18n — setLang persistence + applyDesktopDefault", () => {
  function withStubbedStorage(fn) {
    const store = {};
    global.localStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    };
    try { fn(store); } finally {
      delete global.localStorage;
      i18n.setLang("en", { transient: true });
    }
  }

  it("persists a manual choice and keeps it over the desktop default", () => {
    withStubbedStorage((store) => {
      i18n.setLang("ko");
      assert.strictEqual(store["clawd-lang"], "ko");
      assert.strictEqual(i18n.hasManualChoice(), true);
      i18n.applyDesktopDefault("ja");
      assert.strictEqual(i18n.getLang(), "ko", "manual choice must override the desktop default");
    });
  });

  it("applies the desktop default when there is no manual choice", () => {
    withStubbedStorage(() => {
      i18n.setLang("en", { transient: true });
      assert.strictEqual(i18n.hasManualChoice(), false);
      i18n.applyDesktopDefault("zh-TW");
      assert.strictEqual(i18n.getLang(), "zh-TW");
    });
  });
});

describe("pwa i18n — no hardcoded CJK left in app.js", () => {
  it("app.js contains no CJK characters (all user strings live in i18n.js)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "app.js"), "utf8");
    const found = src.match(/[぀-ヿ一-鿿가-힯]/g);
    assert.strictEqual(found, null,
      found ? `found CJK in app.js: ${[...new Set(found)].join(" ")}` : "");
  });
});

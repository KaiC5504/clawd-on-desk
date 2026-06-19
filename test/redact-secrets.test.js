"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { redactSecrets } = require("../src/redact-secrets.js");

const PLACEHOLDER = "[redacted]";

// Multiline PEM block tests
describe("PEM blocks", () => {
  it("redacts a full PEM block and preserves surrounding lines", () => {
    const input = [
      "before",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEAFAKEKEYBODYHERE1234567890abcdefghij",
      "MOREFAKEKEYDATA5678901234abcdefghijklmnopqrst==",
      "-----END RSA PRIVATE KEY-----",
      "after",
    ].join("\n");

    const out = redactSecrets(input);
    const lines = out.split("\n");
    assert.strictEqual(lines[0], "before");
    assert.strictEqual(lines[lines.length - 1], "after");
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes("FAKEKEYBD"));
    assert.ok(!out.includes("-----BEGIN RSA PRIVATE KEY-----"));
  });

  it("preserves the newline count of surrounding non-secret lines", () => {
    const input = "line1\n-----BEGIN CERTIFICATE-----\nFAKECERTDATA\n-----END CERTIFICATE-----\nline4";
    const out = redactSecrets(input);
    assert.ok(out.startsWith("line1\n"));
    assert.ok(out.endsWith("\nline4"));
  });
});

// Token shape tests
describe("token shapes", () => {
  it("redacts sk- tokens (OpenAI/Anthropic style)", () => {
    const out = redactSecrets("key is sk-FAKEabcdefghijklmnop1234567890");
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes("sk-FAKE"));
  });

  it("redacts ghp_ GitHub token", () => {
    const out = redactSecrets("token: ghp_FAKEabcdefghijklmnopqrstu1234567");
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes("ghp_"));
  });

  it("redacts ghs_ GitHub token (another prefix)", () => {
    const out = redactSecrets("ghs_FAKEabcdefghijklmnopqrstuvwxyz12345");
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes("ghs_"));
  });

  it("redacts xoxb- Slack token", () => {
    const out = redactSecrets("slack token: xoxb-FAKE-1234567890abcdef");
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes("xoxb-"));
  });

  it("redacts xoxp- Slack token", () => {
    const out = redactSecrets("xoxp-FAKE-9999999999-8888888888-aaaabbbb");
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes("xoxp-"));
  });

  it("redacts AWS access key id", () => {
    const out = redactSecrets("aws key: AKIAFAKE1234567890AB");
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes("AKIAFAKE"));
  });

  it("redacts a JWT (three base64url segments)", () => {
    const fakeJwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.FAKE_SIG_abcdefghijk";
    const out = redactSecrets(`auth: ${fakeJwt}`);
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes("eyJhbGci"));
  });
});

// key=value / key: value pair tests
describe("key/value pairs", () => {
  it("redacts api_key= value, keeps key", () => {
    const out = redactSecrets("api_key=sk-FAKEsomesecretvalue123456789");
    assert.ok(out.startsWith("api_key="));
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes("FAKEsomesecret"));
  });

  it("redacts API_KEY: value (case-insensitive)", () => {
    const out = redactSecrets("API_KEY: sk-FAKEsomesecretvalue123456789");
    assert.ok(out.toLowerCase().startsWith("api_key"));
    assert.ok(out.includes(PLACEHOLDER));
  });

  it("redacts password= value, keeps key", () => {
    const out = redactSecrets("password=hunter2FAKE99");
    assert.ok(out.startsWith("password="));
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes("hunter2FAKE99"));
  });

  it("redacts authorization: value", () => {
    const out = redactSecrets("authorization: Bearer sk-FAKEtokenvalue12345678901");
    assert.ok(out.toLowerCase().startsWith("authorization"));
    assert.ok(out.includes(PLACEHOLDER));
  });

  it("redacts the FULL Authorization credential past the scheme word", () => {
    // \S+ stops at the first space and would leak the short base64 credential.
    const out = redactSecrets("Authorization: Basic dXNlcjpwYXNzFAKE");
    assert.ok(out.startsWith("Authorization:"));
    assert.ok(!out.includes("dXNlcjpwYXNzFAKE"));
    assert.ok(out.includes(PLACEHOLDER));
  });

  it("does not consume across newlines for Authorization", () => {
    const out = redactSecrets("Authorization: Basic dXNlcjpwYXNzFAKE\nnext line stays");
    assert.ok(out.endsWith("\nnext line stays"));
    assert.ok(!out.includes("dXNlcjpwYXNzFAKE"));
  });

  it("redacts client_secret= value, keeps key", () => {
    const out = redactSecrets("client_secret=FAKEsecretvalue1234567890");
    assert.ok(out.startsWith("client_secret="));
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes("FAKEsecret"));
  });

  it("redacts secret= in an env-dump context", () => {
    const out = redactSecrets("SECRET=FAKEsomeverylongsecretvalue1");
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes("FAKEsome"));
  });
});

// Bearer / Token header tests
describe("Bearer and Token auth", () => {
  it("redacts Bearer <token>, keeps 'Bearer'", () => {
    // When Bearer appears standalone (not after a key: prefix) it should be kept.
    const out = redactSecrets("Bearer sk-FAKEbearertokenvalue12345678");
    assert.ok(out.includes("Bearer " + PLACEHOLDER));
    assert.ok(!out.includes("FAKEbearer"));
  });

  it("redacts Token <hex>, keeps 'Token'", () => {
    const fakeHex = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const out = redactSecrets(`Token ${fakeHex}`);
    assert.ok(out.includes("Token " + PLACEHOLDER));
    assert.ok(!out.includes(fakeHex));
  });
});

// Long opaque blob test
describe("long opaque blobs", () => {
  it("redacts a standalone >=40-char base64/hex blob", () => {
    const blob = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";
    assert.ok(blob.length >= 40);
    const out = redactSecrets(`here is ${blob} end`);
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes(blob));
  });
});

// Newline preservation
describe("newline preservation", () => {
  it("preserves line count when one line contains a secret", () => {
    const lines = [
      "Hello, this is a message.",
      "api_key=sk-FAKEsomeapikey12345678901234",
      "Please review the above.",
      "Thanks!",
    ];
    const input = lines.join("\n");
    const out = redactSecrets(input);
    const outLines = out.split("\n");
    assert.strictEqual(outLines.length, lines.length);
    assert.strictEqual(outLines[0], lines[0]);
    assert.strictEqual(outLines[2], lines[2]);
    assert.strictEqual(outLines[3], lines[3]);
  });

  it("does not collapse multiple newlines", () => {
    const input = "line1\n\nline3";
    const out = redactSecrets(input);
    assert.strictEqual(out, "line1\n\nline3");
  });
});

// No over-redaction of plain prose
describe("no over-redaction", () => {
  it("leaves a sentence with the word 'token' unchanged if no secret shape present", () => {
    const input = "The token will expire after 24 hours.";
    assert.strictEqual(redactSecrets(input), input);
  });

  it("leaves a sentence with the word 'secret' unchanged if no secret shape present", () => {
    const input = "This is our secret sauce for building great apps.";
    assert.strictEqual(redactSecrets(input), input);
  });
});

// Idempotency
describe("idempotency", () => {
  it("redactSecrets(redactSecrets(x)) === redactSecrets(x) for a string with secrets", () => {
    const input =
      "api_key=sk-FAKEsomeverylongvalue1234567890 and Bearer sk-FAKEanother1234567890abcdef";
    const once = redactSecrets(input);
    const twice = redactSecrets(once);
    assert.strictEqual(twice, once);
  });

  it("placeholder [redacted] does not itself trigger further redaction", () => {
    const out = redactSecrets(PLACEHOLDER);
    assert.strictEqual(out, PLACEHOLDER);
  });
});

// Non-string input handling
describe("non-string inputs", () => {
  it("returns null unchanged for null input", () => {
    assert.strictEqual(redactSecrets(null), null);
  });

  it("returns undefined unchanged for undefined input", () => {
    assert.strictEqual(redactSecrets(undefined), undefined);
  });

  it("returns number unchanged", () => {
    assert.strictEqual(redactSecrets(42), 42);
  });

  it("returns object unchanged", () => {
    const obj = { key: "value" };
    assert.strictEqual(redactSecrets(obj), obj);
  });

  it("handles empty string", () => {
    assert.strictEqual(redactSecrets(""), "");
  });
});

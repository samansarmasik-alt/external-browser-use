import assert from "node:assert/strict";
import test from "node:test";
import { parseCookieHeader, validateHttpUrl } from "../src/server.mjs";

test("only http and https URLs are accepted", () => {
  assert.equal(validateHttpUrl("https://example.com/login"), "https://example.com/login");
  assert.throws(() => validateHttpUrl("file:///C:/secret.txt"), /http/);
  assert.throws(() => validateHttpUrl("javascript:alert(1)"), /http/);
});

test("cookie header parsing keeps values out of descriptions", () => {
  const cookies = parseCookieHeader("sid=abc123; theme=dark", "https://example.com");
  assert.deepEqual(cookies, [
    { name: "sid", value: "abc123", url: "https://example.com/", path: "/" },
    { name: "theme", value: "dark", url: "https://example.com/", path: "/" },
  ]);
});

test("cookie header requires a valid target URL", () => {
  assert.throws(() => parseCookieHeader("sid=abc", "file:///tmp/a"), /http/);
  assert.throws(() => parseCookieHeader("sid", "https://example.com"), /name=value/);
});

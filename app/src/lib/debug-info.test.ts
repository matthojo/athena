import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes, formatDetails, formatWhen } from "./debug-info";

test("formatDetails: a heading, then one line each", () => {
  assert.equal(
    formatDetails([
      { label: "Version", value: "1.0.0" },
      { label: "Mode", value: "Connected" },
    ]),
    "Athena details\nVersion: 1.0.0\nMode: Connected"
  );
});

test("formatBytes: powers of 1024, one decimal under 10", () => {
  assert.equal(formatBytes(1), "1 byte");
  assert.equal(formatBytes(512), "512 bytes");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(2 * 1024 * 1024), "2 MB");
  assert.equal(formatBytes(250 * 1024 * 1024), "250 MB");
  assert.equal(formatBytes(-1), "unknown");
  assert.equal(formatBytes(Number.NaN), "unknown");
});

test("formatWhen: a UTC date and time, or never", () => {
  assert.equal(formatWhen("2026-11-18T09:05:00Z"), "18 Nov 2026, 09:05 UTC");
  assert.equal(formatWhen(null), "never");
  assert.equal(formatWhen("not a date"), "unknown");
});

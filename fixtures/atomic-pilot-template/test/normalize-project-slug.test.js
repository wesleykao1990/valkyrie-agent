import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProjectSlug } from "../src/normalize-project-slug.js";

test("normalizes spaces and case", () => {
  assert.equal(normalizeProjectSlug("  Wesley Project OS  "), "wesley-project-os");
});

test("collapses punctuation runs and trims separators", () => {
  assert.equal(normalizeProjectSlug("---Ovalo___M5 / Pilot---"), "ovalo-m5-pilot");
});

test("rejects a value with no alphanumeric content", () => {
  assert.throws(() => normalizeProjectSlug(" -- ___ "), /alphanumeric/);
});

test("rejects non-string input", () => {
  assert.throws(() => normalizeProjectSlug(42), /string/);
});

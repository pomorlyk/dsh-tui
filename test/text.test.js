// Tests for the pure helpers behind the TUI.

import { test } from "node:test";
import assert from "node:assert/strict";

import { truncate, oneLine, contentText, summarizeInput } from "../src/text.js";
import { createStyle } from "../src/render.js";

test("truncate keeps short text intact", () => {
  assert.equal(truncate("hello", 10), "hello");
  assert.equal(truncate("hello", 5), "hello");
});

test("truncate shortens with an ellipsis and respects the width budget", () => {
  assert.equal(truncate("hello world", 8), "hello w…");
  assert.equal([...truncate("hello world", 8)].length, 8);
});

test("truncate handles degenerate widths", () => {
  assert.equal(truncate("hello", 0), "");
  assert.equal(truncate("hello", 1), "…");
});

test("truncate counts code points, not UTF-16 units", () => {
  // An emoji is a surrogate pair; slicing by code unit would corrupt it.
  assert.equal(truncate("ab🎉cd", 4), "ab🎉…");
});

test("oneLine collapses all whitespace runs", () => {
  assert.equal(oneLine("  a\n\t b   c  "), "a b c");
});

test("contentText joins text parts and summarizes non-text parts in order", () => {
  assert.equal(
    contentText([
      { type: "text", text: "hi " },
      { type: "image" },
      { type: "text", text: "there" },
      { type: "attachment" },
    ]),
    "hi [image]there[attachment]",
  );
});

test("contentText tolerates malformed input", () => {
  assert.equal(contentText(undefined), "");
  assert.equal(contentText("not-an-array"), "");
  assert.equal(contentText([null, { type: "text" }]), "");
});

test("summarizeInput prefers the conventional descriptive field", () => {
  assert.equal(summarizeInput({ command: "ls -la", other: 1 }), "ls -la");
  assert.equal(summarizeInput({ file_path: "/tmp/a.txt" }), "/tmp/a.txt");
});

test("summarizeInput falls back to JSON for unknown shapes", () => {
  assert.equal(summarizeInput({ alpha: 1 }), '{"alpha":1}');
  assert.equal(summarizeInput(null), "");
});

test("summarizeInput collapses newlines in a command", () => {
  assert.equal(summarizeInput({ command: "echo a\necho b" }), "echo a echo b");
});

test("createStyle emits ANSI when enabled and plain text when disabled", () => {
  const on = createStyle(true);
  const off = createStyle(false);
  assert.equal(off.bold("x"), "x");
  assert.match(on.bold("x"), /\u001B\[1mx\u001B\[0m/);
  // Every wrapper is present so callers never hit an undefined style.
  for (const key of ["dim", "bold", "italic", "red", "green", "yellow", "blue", "magenta", "cyan", "gray"]) {
    assert.equal(typeof off[key], "function", `missing style: ${key}`);
  }
});

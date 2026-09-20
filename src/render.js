// dsh-tui — terminal rendering.
//
// Everything printed to the screen goes through here so that colors can be
// disabled in one place and so that the streaming paths (assistant text,
// reasoning, tool output) share one definition of "a finished block".

import { stdout } from "node:process";
import { truncate } from "./text.js";

const ESC = "\u001B[";

/** ANSI SGR sequences, empty when color is disabled. */
export function createStyle(enabled) {
  const wrap = (code) => (text) => (enabled ? `${ESC}${code}m${text}${ESC}0m` : text);
  return {
    enabled,
    dim: wrap("2"),
    bold: wrap("1"),
    italic: wrap("3"),
    red: wrap("31"),
    green: wrap("32"),
    yellow: wrap("33"),
    blue: wrap("34"),
    magenta: wrap("35"),
    cyan: wrap("36"),
    gray: wrap("90"),
  };
}

/**
 * A small renderer that owns all direct terminal writes.
 *
 * The TUI keeps exactly one live ("open") stream at a time — either assistant
 * text or reasoning — so that interleaved deltas never corrupt each other.
 */
export class Renderer {
  /**
   * @param {{style: ReturnType<typeof createStyle>, columns?: number}} options
   */
  constructor(options) {
    this.style = options.style;
    this.columns = options.columns ?? stdout.columns ?? 80;
    this.open = null;
  }

  /** Update the cached terminal width. */
  resize(columns) {
    this.columns = columns;
  }

  /** Write raw text, bypassing block tracking. */
  write(text) {
    stdout.write(text);
  }

  /** Begin a new logical line. */
  line(text = "") {
    this.closeStream();
    stdout.write(`${text}\n`);
  }

  /** End any live stream with a newline so the next block starts cleanly. */
  closeStream() {
    if (this.open === null) return;
    if (this.open.wrote && !this.open.endsWithNewline) stdout.write("\n");
    this.open = null;
  }

  /**
   * Append streamed delta text to a named stream, opening it on first use.
   *
   * @param {string} name - identifies the stream owner (assistant, reasoning).
   * @param {string} text
   * @param {{prefix?: string, color?: (text: string) => string}} [format]
   */
  streamDelta(name, text, format = {}) {
    if (this.open !== null && this.open.name !== name) this.closeStream();
    if (this.open === null) {
      const prefix = format.prefix ?? "";
      const paint = format.color ?? ((value) => value);
      stdout.write(paint(prefix));
      this.open = { name, wrote: prefix.length > 0, endsWithNewline: false };
    }

    const paint = format.color ?? ((value) => value);
    const body = this.open.wrote && this.open.endsWithNewline
      ? text.replace(/^\n+/, "")
      : text;
    if (body.length === 0) return;
    stdout.write(paint(body));
    this.open.wrote = true;
    this.open.endsWithNewline = body.endsWith("\n");
  }

  /** Render a user turn marker. */
  userTurn(text) {
    this.line(`${this.style.green("›")} ${this.style.bold(text)}`);
  }

  /**
   * Render an assistant's completed message when it never streamed deltas.
   *
   * @param {string} text
   */
  assistantMessage(text) {
    this.closeStream();
    if (text.trim().length === 0) return;
    stdout.write(`${text}\n`);
  }

  /**
   * Render a tool invocation line.
   *
   * @param {string} label - the tool name.
   * @param {string} [detail] - a short argument summary.
   */
  toolCall(label, detail) {
    this.closeStream();
    const suffix = detail && detail.length > 0 ? ` ${this.style.gray(detail)}` : "";
    stdout.write(`${this.style.cyan("⏺")} ${this.style.bold(label)}${suffix}\n`);
  }

  /**
   * Render a tool result as an indented, truncated block.
   *
   * @param {string} text
   * @param {{isError?: boolean, maxLines?: number}} [options]
   */
  toolResult(text, options = {}) {
    this.closeStream();
    if (text.trim().length === 0) return;
    const maxLines = options.maxLines ?? 8;
    const lines = text.trimEnd().split("\n");
    const shown = lines.slice(0, maxLines);
    const color = options.isError === true ? this.style.red : this.style.gray;
    for (const line of shown) {
      stdout.write(`${color(`  │ ${truncate(line, this.columns - 4)}`)}\n`);
    }
    if (lines.length > shown.length) {
      stdout.write(`${this.style.gray(`  │ … +${lines.length - shown.length} lines`)}\n`);
    }
  }

  /** Render an inline notice (errors, status, hints). */
  notice(text, tone = "gray") {
    this.line(this.style[tone]?.(text) ?? text);
  }

  /** Render the horizontal rule used between turns. */
  rule() {
    this.line(this.style.gray("─".repeat(Math.min(this.columns, 60))));
  }

  /** Print the input prompt without a trailing newline. */
  prompt(label) {
    stdout.write(`${this.style.green(label)} `);
  }
}

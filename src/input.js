// dsh-tui — raw-mode line editor.
//
// A dependency-free replacement for Node's readline: readline in terminal mode
// occupies the bottom line and redraws it, which fights with a streaming agent
// transcript. This editor instead keeps the transcript intact and re-renders
// only the input row it owns.

import { stdin, stdout } from "node:process";
import { truncate } from "./text.js";

const ESC = "\u001B[";

/** Remove ANSI SGR sequences so control codes do not count as display width. */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

/** Count display width, approximating wide CJK glyphs as two columns. */
function displayWidth(text) {
  let width = 0;
  for (const char of stripAnsi(text)) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f);
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * Read one logical line per submit from a raw TTY.
 *
 * Supported bindings: printable input, Backspace/Delete, Left/Right/Home/End,
 * Up/Down history, Ctrl+A/E/K/U/W, Ctrl+L to clear, Ctrl+C to cancel, and
 * Ctrl+D on an empty line to end input.
 */
export class LineEditor {
  #history = [];
  #historyIndex = 0;
  #draft = "";
  #label;
  #busy = false;
  #render;
  #onData;

  /**
   * @param {{label: string, history?: string[], maxHistory?: number}} options
   */
  constructor(options) {
    this.#label = options.label;
    this.#history = [...(options.history ?? [])];
    this.#historyIndex = this.#history.length;
    this.maxHistory = options.maxHistory ?? 200;
    this.buffer = "";
    this.cursor = 0;
  }

  /** History entries, most recent last. */
  get history() {
    return [...this.#history];
  }

  /** How many physical rows the current input occupies. */
  #rows() {
    const width = Math.max(20, (stdout.columns ?? 80) - 2);
    const total = displayWidth(this.#label) + 1 + displayWidth(this.buffer);
    return Math.max(1, Math.ceil(total / width));
  }

  /** Redraw the input row(s) in place. */
  #paint() {
    if (this.#render !== undefined) this.#render();
    const width = stdout.columns ?? 80;
    const label = this.#label;

    // Clear the rows this editor previously occupied, then rewrite them.
    const rows = this.#rows();
    if (this.previousRows !== undefined && this.previousRows > 1) {
      stdout.write(`${ESC}${this.previousRows - 1}A`);
    }
    stdout.write(`\r${ESC}0J`);

    const visible = truncate(this.buffer, Math.max(0, width - displayWidth(label) - 1));
    stdout.write(`${label} ${visible}`);

    // Park the cursor after the character at `cursor`.
    const before = displayWidth(truncate(this.buffer, this.cursor));
    const afterTotal = displayWidth(truncate(this.buffer, Math.max(0, width - displayWidth(label) - 1)));
    const back = afterTotal - before;
    if (back > 0) stdout.write(`${ESC}${back}D`);
    this.previousRows = rows;
  }

  /** Replace the buffer and move the cursor to the end. */
  #setBuffer(text) {
    this.buffer = text;
    this.cursor = [...text].length;
  }

  /** Commit the current input as history. */
  #commit(text) {
    if (text.trim().length === 0) return;
    if (this.#history[this.#history.length - 1] !== text) {
      this.#history.push(text);
      if (this.#history.length > this.maxHistory) this.#history.shift();
    }
    this.#historyIndex = this.#history.length;
  }

  /**
   * Prompt for one line.
   *
   * @returns {Promise<string|null>} the submitted line, or null on EOF/Ctrl+D.
   */
  readLine(onRender) {
    this.#render = onRender;
    this.buffer = "";
    this.cursor = 0;
    this.previousRows = 1;
    this.#setBuffer("");

    if (stdin.isTTY !== true) return Promise.reject(new Error("standard input is not a TTY"));
    if (stdin.isRaw !== true) stdin.setRawMode(true);
    stdin.resume();

    return new Promise((resolve) => {
      const finish = (value) => {
        stdin.off("data", this.#onData);
        stdout.write("\n");
        resolve(value);
      };

      this.#onData = (chunk) => {
        const text = chunk.toString("utf8");
        for (let index = 0; index < text.length; index += 1) {
          const char = text[index];

          // Escape sequences: arrows, home/end, delete.
          if (char === "\u001B") {
            const rest = text.slice(index);
            if (rest.startsWith(`${ESC}A`)) { this.#historyPrev(); index += 2; continue; }
            if (rest.startsWith(`${ESC}B`)) { this.#historyNext(); index += 2; continue; }
            if (rest.startsWith(`${ESC}C`)) { this.#moveRight(); index += 2; continue; }
            if (rest.startsWith(`${ESC}D`)) { this.#moveLeft(); index += 2; continue; }
            if (rest.startsWith(`${ESC}H`) || rest.startsWith(`${ESC}1~`)) { this.cursor = 0; index += rest.startsWith(`${ESC}H`) ? 2 : 3; continue; }
            if (rest.startsWith(`${ESC}F`) || rest.startsWith(`${ESC}4~`)) { this.cursor = [...this.buffer].length; index += rest.startsWith(`${ESC}F`) ? 2 : 3; continue; }
            if (rest.startsWith(`${ESC}3~`)) { this.#deleteForward(); index += 3; continue; }
            continue;
          }

          if (char === "\r" || char === "\n") {
            const value = this.buffer;
            this.#commit(value);
            this.#paint();
            finish(value);
            return;
          }

          if (char === "\u0004") { // Ctrl+D
            if (this.buffer.length === 0) { finish(null); return; }
            this.#deleteForward();
            continue;
          }

          if (char === "\u0003") { // Ctrl+C
            this.#paint();
            finish("\u0003");
            return;
          }

          if (char === "\u000C") { // Ctrl+L
            stdout.write(`${ESC}2J${ESC}H`);
            this.previousRows = 1;
            this.#paint();
            continue;
          }

          if (char === "\u007F" || char === "\b") { this.#backspace(); continue; }
          if (char === "\u0001") { this.cursor = 0; continue; } // Ctrl+A
          if (char === "\u0005") { this.cursor = [...this.buffer].length; continue; } // Ctrl+E
          if (char === "\u000B") { this.#killToEnd(); continue; } // Ctrl+K
          if (char === "\u0015") { this.#killToStart(); continue; } // Ctrl+U
          if (char === "\u0017") { this.#killWord(); continue; } // Ctrl+W
          if (char < " ") continue;

          this.#insert(char);
        }
        this.#paint();
      };

      stdin.on("data", this.#onData);
    });
  }

  /** Stop reading and restore the terminal. */
  close() {
    if (this.#onData !== undefined) stdin.off("data", this.#onData);
    if (stdin.isTTY === true && stdin.isRaw === true) stdin.setRawMode(false);
    stdin.pause();
  }

  /** Mark the editor busy so a different label can be shown. */
  setBusy(busy) {
    this.#busy = busy;
  }

  #insert(char) {
    const points = [...this.buffer];
    points.splice(this.cursor, 0, char);
    this.buffer = points.join("");
    this.cursor += 1;
  }

  #backspace() {
    if (this.cursor === 0) return;
    const points = [...this.buffer];
    points.splice(this.cursor - 1, 1);
    this.buffer = points.join("");
    this.cursor -= 1;
  }

  #deleteForward() {
    const points = [...this.buffer];
    if (this.cursor >= points.length) return;
    points.splice(this.cursor, 1);
    this.buffer = points.join("");
  }

  #killToEnd() {
    this.buffer = [...this.buffer].slice(0, this.cursor).join("");
  }

  #killToStart() {
    this.buffer = [...this.buffer].slice(this.cursor).join("");
    this.cursor = 0;
  }

  #killWord() {
    const points = [...this.buffer];
    let index = this.cursor;
    while (index > 0 && points[index - 1] === " ") index -= 1;
    while (index > 0 && points[index - 1] !== " ") index -= 1;
    points.splice(index, this.cursor - index);
    this.buffer = points.join("");
    this.cursor = index;
  }

  #moveLeft() {
    if (this.cursor > 0) this.cursor -= 1;
  }

  #moveRight() {
    if (this.cursor < [...this.buffer].length) this.cursor += 1;
  }

  #historyPrev() {
    if (this.#history.length === 0) return;
    if (this.#historyIndex === this.#history.length) this.#draft = this.buffer;
    this.#historyIndex = Math.max(0, this.#historyIndex - 1);
    this.#setBuffer(this.#history[this.#historyIndex] ?? "");
  }

  #historyNext() {
    if (this.#historyIndex >= this.#history.length) return;
    this.#historyIndex += 1;
    this.#setBuffer(
      this.#historyIndex === this.#history.length
        ? this.#draft
        : (this.#history[this.#historyIndex] ?? ""),
    );
  }
}

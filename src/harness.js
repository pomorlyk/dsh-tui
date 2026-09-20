// dsh-tui — a terminal UI for DeepSeek Harness.
//
// The SDK JSON-RPC client: spawns the `sdk` profile of a DSH installation and
// speaks newline-delimited JSON-RPC 2.0 over its stdio. The server reserves
// stdout exclusively for protocol frames, so every line read here must be a
// frame; anything else is surfaced as a diagnostic rather than parsed.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Default DeepSeek endpoint used when the caller sets no base URL. */
const DEFAULT_BASE_URL = "https://api.deepseek.com";

/** Default model when the caller selects none. */
export const DEFAULT_MODEL = "deepseek-v4-flash";

/**
 * Locate a DSH installation that can serve the `sdk` profile.
 *
 * A DSH desktop install ships the CLI inside its app bundle and requires the
 * Electron binary as a Node runtime, while a standalone npm install exposes a
 * plain `dsh` entry. Both are supported so the TUI works either way.
 *
 * @returns {{kind: "desktop", app: string, boot: string} | {kind: "standalone", entry: string}}
 * @throws {Error} when no installation is found.
 */
export function resolveHarness() {
  const override = process.env.DSH_TUI_HARNESS;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`DSH_TUI_HARNESS points at a missing path: ${override}`);
    }
    return { kind: "standalone", entry: override };
  }

  /** Known desktop bundles: [app binary, CLI bootstrap inside the bundle]. */
  const desktopCandidates = [
    [
      "/Applications/DSH Desktop Beta.app/Contents/MacOS/DSH Desktop Beta",
      "/Applications/DSH Desktop Beta.app/Contents/Resources/app/lib/desktop-cli.js",
    ],
    [
      "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop",
      "/Applications/DSH Desktop.app/Contents/Resources/app/lib/desktop-cli.js",
    ],
  ];

  for (const [app, boot] of desktopCandidates) {
    if (existsSync(app) && existsSync(boot)) return { kind: "desktop", app, boot };
  }

  const standalone = join(
    process.env.HOME ?? "",
    ".local/share/dsh-cli/node_modules/.bin/dsh",
  );
  if (existsSync(standalone)) return { kind: "standalone", entry: standalone };

  throw new Error(
    "no DSH installation found. Install DSH Desktop, or `npm i @deepseek-ai/dsh`, " +
      "or point DSH_TUI_HARNESS at a dsh entry point.",
  );
}

/**
 * A live client for one DSH SDK runtime process.
 *
 * Requests are written to the child's stdin; responses and notifications are
 * matched by id on stdout. Notification handlers registered via {@link on} are
 * invoked for every server-pushed frame.
 */
export class HarnessClient {
  #child;
  #nextId = 1;
  #pending = new Map();
  #handlers = new Map();
  #stderrTail = [];
  #closed = false;

  /**
   * Spawn and hold one SDK runtime process.
   *
   * @param {{harness?: object, env?: Record<string, string>, cwd?: string}} [options]
   */
  constructor(options = {}) {
    const harness = options.harness ?? resolveHarness();
    this.harness = harness;

    const env = {
      ...process.env,
      ...options.env,
      // The desktop binary only behaves as a Node runtime when this is set.
      // Without it the process starts as a GUI and the protocol never speaks.
      ...(harness.kind === "desktop" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      DSH_DESKTOP_DEFAULT_PROFILE: "sdk",
    };

    this.#child =
      harness.kind === "desktop"
        ? spawn(harness.app, ["--expose-internals", harness.boot, "--profile", "sdk"], {
            env,
            cwd: options.cwd,
            stdio: ["pipe", "pipe", "pipe"],
          })
        : spawn(harness.entry, ["--profile", "sdk"], {
            env,
            cwd: options.cwd,
            stdio: ["pipe", "pipe", "pipe"],
          });

    this.#child.on("error", (error) => this.#fail(error));
    this.#child.on("exit", (code, signal) => {
      this.#fail(
        new Error(
          `harness SDK runtime exited (code=${String(code)}, signal=${String(signal)})` +
            (this.#stderrTail.length > 0
              ? `\n${this.#stderrTail.join("\n").trim()}`
              : ""),
        ),
      );
    });

    this.#child.stderr.on("data", (buffer) => {
      this.#stderrTail.push(String(buffer));
      if (this.#stderrTail.length > 40) this.#stderrTail.shift();
    });

    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      this.#onLine(line);
    });
  }

  /**
   * Register a notification handler.
   *
   * @param {string} method - the JSON-RPC notification method.
   * @param {(params: any) => void} handler
   */
  on(method, handler) {
    this.#handlers.set(method, handler);
  }

  /** Reject every pending request; used when the child dies. */
  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
    const handler = this.#handlers.get("__exit");
    if (handler !== undefined) handler(error);
  }

  /** Route one stdout line to its pending request or notification handler. */
  #onLine(line) {
    const trimmed = line.trim();
    if (trimmed === "") return;

    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      const handler = this.#handlers.get("__noise");
      if (handler !== undefined) handler(trimmed);
      return;
    }

    if (frame.id !== undefined && frame.method === undefined) {
      const entry = this.#pending.get(frame.id);
      if (entry === undefined) return;
      this.#pending.delete(frame.id);
      if (frame.error !== undefined) {
        const error = new Error(frame.error.message ?? "JSON-RPC error");
        error.data = frame.error.data;
        entry.reject(error);
      } else {
        entry.resolve(frame.result);
      }
      return;
    }

    if (frame.method !== undefined) {
      const handler = this.#handlers.get(frame.method);
      if (handler !== undefined) handler(frame.params);
    }
  }

  /**
   * Send one request and await its result.
   *
   * @param {string} method
   * @param {object} params
   * @returns {Promise<any>}
   */
  request(method, params) {
    if (this.#closed) return Promise.reject(new Error("harness SDK runtime is not running"));
    const id = `req_${this.#nextId++}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /**
   * Select the runtime's working directory, provider, and model.
   *
   * The Gemini-style `resolveCallConfig` check happens server-side, so an
   * unusable model or missing credential surfaces as a rejected request.
   *
   * @param {{cwd: string, model?: string, provider?: string, reasoningEffort?: string, maxTokens?: number}} options
   */
  initialize(options) {
    const params = {
      cwd: options.cwd,
      provider: options.provider ?? "deepseek-official",
      model: options.model ?? DEFAULT_MODEL,
    };
    if (options.reasoningEffort !== undefined) params.reasoningEffort = options.reasoningEffort;
    if (options.maxTokens !== undefined) params.maxTokens = options.maxTokens;
    return this.request("initialize", params);
  }

  /**
   * Queue one user turn on a session, creating the session on first use.
   *
   * Reusing the same sessionId continues the same conversation with full
   * history — this is what makes the TUI multi-turn rather than one-shot.
   *
   * @param {{sessionId: string, text: string}} options
   * @returns {Promise<{messageId: string}>}
   */
  prompt(options) {
    return this.request("session/prompt", {
      sessionId: options.sessionId,
      contentBlocks: [{ type: "text", text: options.text }],
    });
  }

  /** Ask the runtime to dispose its agents and exit cleanly. */
  async shutdown() {
    try {
      await this.request("shutdown", {});
    } catch {
      // The child may already be gone; teardown below is best-effort.
    }
    this.close();
  }

  /** Close stdin and end the child process. */
  close() {
    this.#closed = true;
    try {
      this.#child.stdin.end();
    } catch {
      // Already closed.
    }
    const timer = setTimeout(() => this.#child.kill("SIGKILL"), 2000);
    timer.unref?.();
  }
}

export { DEFAULT_BASE_URL };

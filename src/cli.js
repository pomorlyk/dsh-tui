#!/usr/bin/env node
// dsh-tui — a terminal UI for DeepSeek Harness.
//
// Boots the `sdk` profile of a local DSH installation, drives it over JSON-RPC
// on stdio, and renders an interactive multi-turn session in the terminal.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";

import { HarnessClient, resolveHarness, DEFAULT_MODEL } from "./harness.js";
import { createStyle, Renderer } from "./render.js";
import { LineEditor } from "./input.js";
import { ChatSession } from "./session.js";

const VERSION = "0.1.0";
const STATE_DIR = join(homedir(), ".dsh-tui");
const STATE_FILE = join(STATE_DIR, "state.json");

const HELP = `dsh-tui — a terminal UI for DeepSeek Harness

Usage: dsh-tui [options]

Options:
  -m, --model <name>     model to use (default: ${DEFAULT_MODEL})
  -C, --cwd <path>       working directory for the agent (default: current)
      --effort <level>   reasoning effort: low | medium | high
      --max-tokens <n>   response token ceiling
      --no-color         disable ANSI colors
      --continue         resume the most recent local session
      --print <task>     answer one task, print the result, and exit
  -h, --help             show this help
  -V, --version          print the version

Environment:
  DEEPSEEK_API_KEY    API key for the deepseek-official provider
  DSH_TUI_HARNESS     explicit path to a dsh entry point
  DEEPSEEK_BASE_URL   alternate API base URL

Keys:
  Enter        send the message
  Ctrl+C       quit (waits for a running turn; the SDK protocol has no cancel)
  Ctrl+D       quit on an empty prompt
  Up / Down    browse input history
  Ctrl+L       clear the screen
`;

/**
 * Parse command-line arguments.
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = {
    model: DEFAULT_MODEL,
    cwd: process.cwd(),
    effort: undefined,
    maxTokens: undefined,
    color: true,
    continue: false,
    print: undefined,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = (name) => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${name} requires a value`);
      index += 1;
      return value;
    };

    switch (arg) {
      case "-m":
      case "--model":
        options.model = takeValue(arg);
        break;
      case "-C":
      case "--cwd":
        options.cwd = resolve(takeValue(arg));
        break;
      case "--effort":
        options.effort = takeValue(arg);
        break;
      case "--max-tokens": {
        const value = Number(takeValue(arg));
        if (!Number.isSafeInteger(value) || value <= 0) {
          throw new Error("--max-tokens must be a positive integer");
        }
        options.maxTokens = value;
        break;
      }
      case "--no-color":
        options.color = false;
        break;
      case "--continue":
        options.continue = true;
        break;
      case "--print":
        options.print = takeValue(arg);
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-V":
      case "--version":
        options.version = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  return options;
}

/** Read persisted local state (recent session id), tolerating absence. */
function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Persist local state, ignoring failures in read-only environments. */
function writeState(state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Local history is a convenience; losing it must not break the session.
  }
}

/**
 * Resolve the API key for the deepseek-official provider.
 *
 * Checked in order: the environment, then the macOS login keychain entry the
 * bundled credentials helper uses. Nothing is written to disk.
 *
 * @returns {string|undefined}
 */
function resolveApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  if (process.platform !== "darwin") return undefined;
  try {
    const value = execFileSync(
      "security",
      ["find-generic-password", "-a", process.env.USER ?? "", "-s", "deepseek-api-key", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Print one non-interactive answer and exit with the turn's status. */
async function runPrint(options, client, style, renderer) {
  const session = new ChatSession({
    client,
    renderer,
    style,
    sessionId: `print-${randomUUID()}`,
  });
  try {
    await session.send(options.print);
    return 0;
  } catch (error) {
    renderer.notice(`error: ${error.message}`, "red");
    return 1;
  }
}

/** Run the interactive REPL. */
async function runInteractive(options, client, style, renderer, history) {
  const previous = options.continue ? readState() : {};
  const sessionId = typeof previous.sessionId === "string" ? previous.sessionId : randomUUID();
  const session = new ChatSession({ client, renderer, style, sessionId });

  if (typeof previous.sessionId === "string") {
    renderer.notice(`resuming session ${sessionId.slice(0, 8)}`, "gray");
  }
  renderer.notice(
    `deepseek harness · ${options.model} · ${options.cwd}`,
    "gray",
  );
  renderer.notice("Enter sends · Ctrl+C quits · Ctrl+D quits · /help for commands", "gray");
  renderer.line();

  const editor = new LineEditor({ label: style.green("›"), history });
  let interruptArmed = false;

  const cleanup = () => {
    editor.close();
    writeState({
      sessionId,
      history: editor.history,
      updatedAt: new Date().toISOString(),
    });
  };

  process.on("SIGINT", () => {
    // The SDK runtime offers no way to cancel an in-flight turn, so Ctrl+C is a
    // quit request; while a turn runs it explains that instead of faking a stop.
    if (session.phase === "running") {
      renderer.notice(
        "a turn is running — the SDK protocol has no cancel, so it must finish first",
        "yellow",
      );
      return;
    }
    cleanup();
    process.exit(0);
  });

  for (;;) {
    let line;
    try {
      editor.setBusy(false);
      line = await editor.readLine();
    } catch (error) {
      renderer.notice(`input error: ${error.message}`, "red");
      cleanup();
      return 1;
    }

    if (line === null) break;
    if (line === "\u0003") {
      if (interruptArmed) break;
      interruptArmed = true;
      renderer.notice("press Ctrl+C again to quit", "yellow");
      continue;
    }
    interruptArmed = false;

    const text = line.trim();
    if (text.length === 0) continue;
    if (text === "/exit" || text === "/quit") break;
    if (text === "/help") {
      renderer.notice("commands: /help /exit /clear", "gray");
      continue;
    }
    if (text === "/clear") {
      stdout.write("\u001B[2J\u001B[H");
      continue;
    }

    editor.setBusy(true);
    try {
      await session.send(text);
    } catch (error) {
      renderer.notice(`error: ${error.message}`, "red");
    }
  }

  cleanup();
  return 0;
}

/** Entry point. */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    stdout.write(HELP);
    return 0;
  }
  if (options.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }

  const interactive = options.print === undefined;
  if (interactive && stdin.isTTY !== true) {
    process.stderr.write("dsh-tui: interactive mode needs a TTY; use --print <task> instead\n");
    return 2;
  }

  const style = createStyle(options.color && stdout.isTTY === true);
  const renderer = new Renderer({ style });

  if (interactive && stdout.isTTY === true) {
    stdout.on("resize", () => renderer.resize(stdout.columns ?? 80));
  }

  let client;
  try {
    client = new HarnessClient({});
  } catch (error) {
    process.stderr.write(`dsh-tui: ${error.message}\n`);
    return 2;
  }

  const apiKey = resolveApiKey();
  if (apiKey === undefined) {
    renderer.notice(
      "warning: DEEPSEEK_API_KEY is not set and no keychain entry was found; " +
        "the model call will likely fail.",
      "yellow",
    );
  }

  // The keychain fallback must reach the child process, not just validation:
  // HarnessClient inherits process.env when it spawns the runtime.
  if (apiKey !== undefined) process.env.DEEPSEEK_API_KEY = apiKey;

  client.on("__noise", (line) => renderer.notice(`[harness] ${line}`, "gray"));
  client.on("__exit", (error) => {
    if (interactive) renderer.notice(`harness stopped: ${error.message}`, "red");
  });

  let code = 0;
  try {
    await client.initialize({
      cwd: options.cwd,
      model: options.model,
      ...(options.effort === undefined ? {} : { reasoningEffort: options.effort }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    });

    const history = readState().history;
    code = interactive
      ? await runInteractive(options, client, style, renderer, history)
      : await runPrint(options, client, style, renderer);
  } catch (error) {
    renderer.notice(`fatal: ${error.message}`, "red");
    code = 1;
  } finally {
    await client.shutdown();
  }

  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`dsh-tui: unexpected failure: ${error?.stack ?? String(error)}\n`);
    process.exit(1);
  });

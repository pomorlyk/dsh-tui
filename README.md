# dsh-tui

A terminal UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — an interactive,
multi-turn coding-agent session that lives in your shell instead of a browser tab.

> **Unofficial.** This is a third-party client built on the DSH SDK protocol. It is not affiliated with
> or endorsed by DeepSeek. DSH ships no terminal surface of its own as of 0.1.5-rc.2; this project
> adds one.

## Why this exists

DSH ships six profile bundles — `web-app`, `headless`, `acp-app`, `sdk-app`, `sdk-minimal`, and `base` —
and none of them is an interactive terminal UI:

- `--profile headless` answers **one** task and exits. Its command provider parses a single `task`
  positional and exposes no session or resume flag, so it cannot hold a conversation.
- `--profile web-app` (the default `dsh`) opens a **browser** surface.
- `--profile acp` and `--profile sdk` are JSON-RPC **servers** with no UI.

`dsh-tui` uses the `sdk` profile as its backend and supplies the missing front end: a real terminal UI
where a conversation persists across turns and context is retained.

## Requirements

- **Node.js ≥ 20** (developed and tested on Node 22 and 26)
- A local DSH installation, either:
  - **DSH Desktop** — `dsh-tui` locates it in `/Applications` automatically, or
  - **standalone CLI** — `npm i @deepseek-ai/dsh`, or
  - an explicit path via `DSH_TUI_HARNESS`
- A DeepSeek API key, either in `DEEPSEEK_API_KEY` or in the macOS login keychain under the service
  name `deepseek-api-key`

No runtime dependencies: the CLI, JSON-RPC transport, and line editor are all in `src/`.

## Install

```sh
git clone git@github.com:pomorlyk/dsh-tui.git
cd dsh-tui
node src/cli.js --help
```

Or link it onto your `PATH`:

```sh
npm link          # provides the `dsh-tui` command
```

## Usage

```sh
dsh-tui                                   # interactive session in the current directory
dsh-tui -m deepseek-v4-pro                # pick a model
dsh-tui -C ~/code/project                 # run the agent against another directory
dsh-tui --effort high                     # low | medium | high
dsh-tui --continue                        # resume the most recent local session
dsh-tui --print "explain this repo"       # one-shot: answer, print, exit
```

| Key | Action |
| --- | --- |
| `Enter` | send the message |
| `Ctrl+C` | quit (twice in a row, so a stray press is not fatal) |
| `Ctrl+D` | quit on an empty prompt |
| `Up` / `Down` | browse input history |
| `Ctrl+L` | clear the screen |
| `Ctrl+A` / `Ctrl+E` | jump to start / end of line |
| `Ctrl+U` / `Ctrl+K` / `Ctrl+W` | kill to start / end / previous word |

In-session commands: `/help`, `/clear`, `/exit`.

## How it works

```
dsh-tui (Node)
  │
  ├─ spawns ─▶ dsh --profile sdk        (DSH Desktop binary or standalone CLI)
  │              │
  │              ├─ stdout ─▶ newline-delimited JSON-RPC 2.0  ─▶ client
  │              └─ stdin  ◀─ requests                       ◀─ client
  │
  └─ renders transcript + owns the raw-mode input row
```

The runtime speaks exactly three request methods and pushes notifications:

| Direction | Name | Purpose |
| --- | --- | --- |
| → | `initialize` | select `cwd`, `provider`, `model`, optional `reasoningEffort` / `maxTokens` |
| → | `session/prompt` | queue one user turn; reusing `sessionId` continues the conversation |
| → | `shutdown` | dispose agents and exit cleanly |
| ← | `session.event` | streaming: assistant text, reasoning, tool calls and results |
| ← | `session.status` | `running` → `idle`, which marks the end of a turn |

Assistant output arrives **twice** by design: incrementally through `stream[].text-chunks` while it is
generated, and again as the authoritative final message. The renderer paints the deltas and suppresses
the duplicate final text, so a reply is never printed twice. This is covered by a test.

### Two things that are easy to get wrong

1. **`ELECTRON_RUN_AS_NODE=1` is mandatory for a DSH Desktop backend.** Without it the Electron binary
   starts as a GUI and the protocol never speaks — the child exits immediately with no output at all,
   which looks like a hung request rather than a misconfiguration.
2. **`--profile sdk` must be selected explicitly.** A DSH Desktop install defaults to the `desktop`
   (browser) profile, which does not serve the SDK protocol.

## Known limitations

- **A running turn cannot be cancelled.** The SDK runtime exposes no cancel method — `session/cancel`
  is rejected with `unknown DeepSeek Harness SDK runtime method`. While a turn is running, `Ctrl+C`
  explains this instead of pretending to interrupt, and the process waits for the turn to finish.
- **Tool call/result rendering is best-effort.** The exact `tool/call` and `tool/result` payload shape
  was not documented in the bundled packages, so the handler accepts several plausible field names and
  degrades to showing nothing rather than throwing. Streaming text, reasoning, and turn state are
  verified against a live runtime; tool rendering is not.
- **`--continue` is local only.** The SDK protocol cannot list sessions, so this resumes the last
  session id this client stored in `~/.dsh-tui/state.json` — not an arbitrary prior conversation.
- **No image or attachment input.** `session/prompt` accepts image content blocks, but this UI only
  sends text.
- **Tested on macOS.** The desktop-app discovery and the keychain fallback are macOS-specific; other
  platforms need `DSH_TUI_HARNESS` and `DEEPSEEK_API_KEY`.
- **The interactive screen was not verified against a real TTY.** It was developed in a
  non-interactive environment (`stdin.isTTY` is undefined there), so `--print` mode, the protocol
  client, and the event/rendering logic are covered by live runs and tests, but the raw-mode
  transcript layout has only been exercised through those tests. If it renders badly in your
  terminal, that is the part to look at first.

## Privacy

Your prompts and the agent's requests go to the DeepSeek API using your own key. `dsh-tui` writes only
session ids and input history to `~/.dsh-tui/state.json` (mode `0600`); it never writes the API key to
disk. When no key is present in the environment it reads the existing `deepseek-api-key` keychain entry
and passes it to the child process through the environment.

## Tests

```sh
npm test
```

Covers the text helpers, ANSI style toggling, and the stream-deduplication rule that keeps replies from
printing twice.

## License

MIT

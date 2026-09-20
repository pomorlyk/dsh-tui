// dsh-tui — session controller.
//
// Translates the SDK runtime's `session.event` notifications into renderer
// calls and tracks turn state. Two sources describe the same assistant output:
// the live `stream` deltas inside each event, and the authoritative final
// message. The live deltas paint progressively; the final message is only
// painted when nothing streamed, which avoids double-printing either way.

import { contentText, oneLine, summarizeInput, truncate } from "./text.js";

/** Turn phases the UI exposes. */
export const Phase = {
  IDLE: "idle",
  RUNNING: "running",
};

/**
 * Drives one SDK session and renders its events.
 */
export class ChatSession {
  #client;
  #render;
  #style;
  #phase = Phase.IDLE;
  #waiters = [];
  #sawAssistantDelta = false;
  #sawReasoningDelta = false;
  #pendingToolCall = null;

  /**
   * @param {{client: object, renderer: object, style: object, sessionId: string}} options
   */
  constructor(options) {
    this.#client = options.client;
    this.#render = options.renderer;
    this.#style = options.style;
    this.sessionId = options.sessionId;
    this.turns = 0;

    this.#client.on("session.event", (params) => this.#onEvent(params));
    this.#client.on("session.status", (params) => this.#onStatus(params));
  }

  /** Current phase. */
  get phase() {
    return this.#phase;
  }

  /**
   * Submit one user turn and resolve when the turn finishes.
   *
   * @param {string} text
   * @returns {Promise<void>}
   */
  async send(text) {
    if (this.#phase === Phase.RUNNING) throw new Error("a turn is already running");
    this.#phase = Phase.RUNNING;
    this.#sawAssistantDelta = false;
    this.#sawReasoningDelta = false;
    this.#render.userTurn(text);
    try {
      await this.#client.prompt({ sessionId: this.sessionId, text });
      await this.#waitForTurnEnd();
    } finally {
      this.#render.closeStream();
      this.#phase = Phase.IDLE;
    }
  }

  /** Resolve once the runtime reports the session idle. */
  #waitForTurnEnd() {
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  /** Handle `session.status` notifications. */
  #onStatus(params) {
    if (params?.sessionId !== this.sessionId) return;
    if (params.status === "idle") {
      const waiters = this.#waiters;
      this.#waiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  /** Handle one `session.event` notification. */
  #onEvent(params) {
    if (params?.sessionId !== this.sessionId) return;
    const event = params.event;
    if (event === undefined) return;

    switch (event.type) {
      case "assistant/message":
        this.#onAssistantMessage(event.data);
        return;
      case "reasoning/message":
        this.#onReasoningMessage(event.data);
        return;
      case "tool/call":
        this.#onToolCall(event.data);
        return;
      case "tool/result":
        this.#onToolResult(event.data);
        return;
      default:
        return;
    }
  }

  /** Paint live assistant deltas from the event's stream, else the final text. */
  #onAssistantMessage(data) {
    let streamed = false;
    for (const entry of data?.stream ?? []) {
      if (entry.type === "text-chunks") {
        for (const piece of entry.texts ?? []) {
          this.#render.streamDelta("assistant", piece);
          streamed = true;
        }
      }
    }

    if (streamed) {
      this.#sawAssistantDelta = true;
      this.#render.closeStream();
      return;
    }

    const text = contentText(data?.message?.content);
    if (text.trim().length === 0) return;
    this.#render.assistantMessage(text);
    this.#render.closeStream();
  }

  /** Paint live reasoning deltas, dimmed and prefixed. */
  #onReasoningMessage(data) {
    let streamed = false;
    for (const entry of data?.stream ?? []) {
      if (entry.type === "text-chunks") {
        for (const piece of entry.texts ?? []) {
          this.#render.streamDelta("reasoning", piece, {
            prefix: `${this.#style.gray("✻ ")}`,
            color: this.#style.gray,
          });
          streamed = true;
        }
      }
    }
    if (streamed) return;

    const text = contentText(data?.message?.content);
    if (text.trim().length === 0) return;
    this.#render.notice(truncate(`✻ ${oneLine(text)}`, 100));
  }

  /** Show a tool invocation as it starts. */
  #onToolCall(data) {
    const name = data?.name ?? data?.toolName ?? "tool";
    const detail = summarizeInput(data?.input ?? data?.args, 100);
    this.#pendingToolCall = name;
    this.#render.toolCall(name, detail);
  }

  /** Show a tool result, truncated, marking failures. */
  #onToolResult(data) {
    const text = contentText(data?.content) || (typeof data?.output === "string" ? data.output : "");
    const isError = data?.isError === true || data?.status === "error";
    this.#render.toolResult(text, { isError });
    this.#pendingToolCall = null;
  }

  /**
   * Report whether a running turn can be cancelled.
   *
   * The DSH SDK runtime exposes exactly three methods — `initialize`,
   * `session/prompt`, and `shutdown` — and none of them cancels an in-flight
   * turn. Interruption is therefore unavailable rather than merely unimplemented
   * here, and the UI must say so instead of pretending to stop the agent.
   *
   * @returns {false}
   */
  canInterrupt() {
    return false;
  }
}

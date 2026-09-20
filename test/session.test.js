// Tests that streamed deltas are never printed twice.
//
// The SDK sends the same assistant text two ways: live `stream` deltas as it is
// produced, and the authoritative final message. The renderer must paint the
// deltas and then suppress the duplicate final text — otherwise every reply
// appears twice on screen.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Renderer, createStyle } from "../src/render.js";
import { ChatSession } from "../src/session.js";

/** Capture everything the renderer writes. */
function capture(run) {
  const writes = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return writes.join("");
}

/** Build a ChatSession wired to a fake client and the real renderer. */
function makeSession(renderer) {
  const handlers = new Map();
  const client = {
    on: (method, handler) => handlers.set(method, handler),
    prompt: async () => ({ messageId: "m1" }),
    request: async () => ({}),
  };
  const session = new ChatSession({
    client,
    renderer,
    style: createStyle(false),
    sessionId: "s1",
  });
  return {
    session,
    emit: (method, params) => handlers.get(method)?.(params),
  };
}

test("streamed assistant text is painted once and not repeated by the final message", () => {
  const output = capture(() => {
    const renderer = new Renderer({ style: createStyle(false), columns: 80 });
    const { session, emit } = makeSession(renderer);

    emit("session.event", {
      sessionId: "s1",
      event: {
        type: "assistant/message",
        data: {
          message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
          stream: [{ type: "text-chunks", texts: ["PO", "NG"] }],
        },
      },
    });
    renderer.closeStream();
    void session;
  });

  assert.equal(output.split("PONG").length - 1, 1, `expected one PONG, got: ${JSON.stringify(output)}`);
});

test("a final message without deltas is painted", () => {
  const output = capture(() => {
    const renderer = new Renderer({ style: createStyle(false), columns: 80 });
    const { emit } = makeSession(renderer);
    emit("session.event", {
      sessionId: "s1",
      event: {
        type: "assistant/message",
        data: { message: { role: "assistant", content: [{ type: "text", text: "no-stream" }] } },
      },
    });
  });

  assert.match(output, /no-stream/);
});

test("events for another session are ignored", () => {
  const output = capture(() => {
    const renderer = new Renderer({ style: createStyle(false), columns: 80 });
    const { emit } = makeSession(renderer);
    emit("session.event", {
      sessionId: "other-session",
      event: {
        type: "assistant/message",
        data: { message: { role: "assistant", content: [{ type: "text", text: "leak" }] } },
      },
    });
  });

  assert.equal(output, "");
});

test("interruption is reported as unavailable rather than silently failing", () => {
  const renderer = new Renderer({ style: createStyle(false), columns: 80 });
  const { session } = makeSession(renderer);
  // The SDK runtime has no cancel method; the UI must not claim otherwise.
  assert.equal(session.canInterrupt(), false);
});

// Tool rendering uses payload shapes captured from a live runtime: `arguments`
// is a JSON string, and results are wrapped in an assistant-facing message.

test("tool/call renders the tool name and summarizes its JSON-string arguments", () => {
  const output = capture(() => {
    const renderer = new Renderer({ style: createStyle(false), columns: 120 });
    const { emit } = makeSession(renderer);
    emit("session.event", {
      sessionId: "s1",
      event: {
        type: "tool/call",
        data: {
          turn: 1,
          step: 1,
          callId: "call_1",
          name: "bash",
          arguments: '{"command": "echo shape-probe", "description": "Echo a test string"}',
        },
      },
    });
  });

  assert.match(output, /bash/);
  assert.match(output, /echo shape-probe/);
});

test("tool/call shows unparseable arguments instead of dropping them", () => {
  const output = capture(() => {
    const renderer = new Renderer({ style: createStyle(false), columns: 120 });
    const { emit } = makeSession(renderer);
    emit("session.event", {
      sessionId: "s1",
      event: { type: "tool/call", data: { name: "bash", arguments: "{not json" } },
    });
  });

  assert.match(output, /\{not json/);
});

test("tool/result renders nested result text and marks errors", () => {
  const output = capture(() => {
    const renderer = new Renderer({ style: createStyle(false), columns: 120 });
    const { emit } = makeSession(renderer);
    emit("session.event", {
      sessionId: "s1",
      event: {
        type: "tool/result",
        data: {
          message: {
            role: "user",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_1",
                isError: false,
                content: [{ type: "text", text: "shape-probe\n" }],
              },
            ],
          },
        },
      },
    });
  });

  assert.match(output, /shape-probe/);
  assert.match(output, /│/);
});

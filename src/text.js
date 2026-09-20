// dsh-tui — text helpers shared by the renderer and the session layer.

/**
 * Truncate to a display width, appending an ellipsis when shortened.
 *
 * Width is counted in code points rather than bytes so that CJK and other
 * multi-byte text does not lose characters unexpectedly; combining marks and
 * double-width glyphs are approximated, which is sufficient for one-line
 * summaries of tool arguments.
 *
 * @param {string} text
 * @param {number} width - maximum number of code points to keep.
 * @returns {string}
 */
export function truncate(text, width) {
  if (width <= 0) return "";
  const points = [...text];
  if (points.length <= width) return text;
  if (width === 1) return "…";
  return `${points.slice(0, width - 1).join("")}…`;
}

/**
 * Collapse whitespace so a value can be shown on a single line.
 *
 * @param {string} text
 * @returns {string}
 */
export function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Extract the display text from a message content part list.
 *
 * DSH content parts are discriminated by `type`; only text parts carry
 * user-visible prose, while image and attachment parts are summarized.
 *
 * @param {Array<{type: string, text?: string, mimeType?: string}>} content
 * @returns {string}
 */
export function contentText(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
    else if (part?.type === "image") parts.push("[image]");
    else if (part?.type === "attachment") parts.push("[attachment]");
  }
  return parts.join("");
}

/**
 * Summarize tool input for a one-line display.
 *
 * Tools accept heterogeneous argument objects, so this picks the most
 * descriptive conventional field and falls back to compact JSON.
 *
 * @param {unknown} input
 * @param {number} width
 * @returns {string}
 */
export function summarizeInput(input, width = 100) {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return truncate(oneLine(input), width);
  if (typeof input !== "object") return truncate(String(input), width);

  const record = /** @type {Record<string, unknown>} */ (input);
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "prompt"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return truncate(oneLine(value), width);
    }
  }

  try {
    return truncate(oneLine(JSON.stringify(record)), width);
  } catch {
    return "";
  }
}

import { normalizeTuiAction } from "./tui-actions.js";
import { isTuiTextOverlay } from "./tui-overlays.js";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} value
 */
function isPrintable(value) {
  return value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * @param {{ str?: string, key?: Record<string, unknown>, model?: { overlay?: string | null, focusRegion?: string, promptBuffer?: string, promptMode?: boolean } | null, runCount?: number }} input
 */
export function parseKeyIntent({ str = "", key = {}, model = null, runCount = 0 } = {}) {
  const name = typeof key.name === "string" ? key.name : "";
  const ctrl = key.ctrl === true;
  const shift = key.shift === true;
  const sequence = typeof key.sequence === "string" ? key.sequence : str;
  const overlay = model?.overlay ?? null;
  const textOverlay = isTuiTextOverlay(overlay);
  const inTextEntry = textOverlay ||
    model?.promptMode === true ||
    model?.focusRegion === "prompt";

  if (ctrl && name === "c") {
    return { type: "quit" };
  }
  if (name === "tab") {
    return { type: shift ? "focusPrevious" : "focusNext" };
  }
  if (name === "return" || name === "enter" || sequence === "\r" || sequence === "\n") {
    return { type: "open" };
  }
  if (name === "escape" || sequence === "\u001b") {
    return { type: "close" };
  }
  if (name === "backspace" || name === "delete") {
    return { type: "deleteText" };
  }
  if (name === "up") {
    return { type: "moveUp", runCount };
  }
  if (name === "down") {
    return { type: "moveDown", runCount };
  }
  if (name === "left") {
    return { type: "moveLeft" };
  }
  if (name === "right") {
    return { type: "moveRight" };
  }
  if (overlay && !textOverlay && !ctrl && isPrintable(str)) {
    return null;
  }
  if (!ctrl && isPrintable(str)) {
    if (!inTextEntry && /^[1-9]$/.test(str)) {
      return { type: "selectRunShortcut", index: Number(str) - 1 };
    }
    if (!inTextEntry) {
      const action = normalizeTuiAction(str);
      if (action) {
        return { type: "action", action };
      }
    }
    return { type: "appendText", text: str };
  }
  return null;
}

/**
 * @param {unknown} stream
 */
export function enableRawMode(stream) {
  const candidate = isRecord(stream) ? stream : null;
  if (candidate && typeof candidate.setRawMode === "function" && candidate.isTTY !== false) {
    /** @type {{ setRawMode: (enabled: boolean) => unknown }} */ (candidate).setRawMode(true);
    return true;
  }
  return false;
}

/**
 * @param {unknown} stream
 */
export function disableRawMode(stream) {
  const candidate = isRecord(stream) ? stream : null;
  if (candidate && typeof candidate.setRawMode === "function" && candidate.isTTY !== false) {
    /** @type {{ setRawMode: (enabled: boolean) => unknown }} */ (candidate).setRawMode(false);
  }
}

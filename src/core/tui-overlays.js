const TUI_TEXT_OVERLAYS = new Set(["noteInput", "verifyInput", "followUpInput"]);

/** @param {string | null} overlay */
export function isTuiTextOverlay(overlay) {
  return overlay !== null && TUI_TEXT_OVERLAYS.has(overlay);
}

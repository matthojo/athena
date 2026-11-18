// One name for the extension API: `browser` in Firefox and Safari, `chrome` in Chromium.
export const ext = globalThis.browser ?? globalThis.chrome;

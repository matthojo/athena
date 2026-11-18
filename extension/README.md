# Save to Athena

A browser extension that saves the page you're on, a quote, an image or a link to your own Athena. One codebase, Manifest V3, for Chrome, Edge, Firefox and Safari.

## Build

Needs Node 22. There are no dependencies to install.

```sh
cd extension
npm run build      # dist/chrome, dist/firefox, dist/safari
npm run zip        # dist/save-to-athena-chrome-<version>.zip and -firefox-<version>.zip
```

The zips are what you'd upload to the Chrome Web Store and Firefox Add-ons. Nothing is published.

## Load it unpacked

**Chrome or Edge.** Open `chrome://extensions` (or `edge://extensions`), turn on Developer mode, choose **Load unpacked** and pick `extension/dist/chrome`.

**Firefox.** Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…** and pick `extension/dist/firefox/manifest.json`. A temporary add-on goes away when Firefox quits. To keep it, sign the zip through AMO as an unlisted add-on. AMO needs an add-on id that is yours alone: build with `ATHENA_GECKO_ID=save-to-athena@yourdomain npm run build` (any address-shaped id you own) and keep the same id for every later build, or Firefox treats it as a different add-on.

**Safari (macOS).** Safari takes a web extension wrapped in an app. With Xcode installed:

```sh
cd extension && npm run build
xcrun safari-web-extension-converter dist/safari \
  --app-name "Save to Athena" --bundle-identifier com.yourdomain.save-to-athena \
  --macos-only --no-open --project-location ~/Developer/save-to-athena-safari
```

Open the generated project in Xcode, pick the macOS scheme, and run it. Then in Safari: Settings → Advanced → turn on "Show features for web developers", Develop → Allow Unsigned Extensions, and turn on Save to Athena under Settings → Extensions. Keep the Xcode project out of this repo; rerun the converter after a rebuild. The Safari build hasn't been tried yet (no Mac here).

## Set up

1. In Athena, go to Settings → API keys and make a **capture** key. It starts with `athc_`. A capture key can add things but can't read anything back. The extension refuses a full-access key.
2. The extension's settings page opens when you install it. Otherwise right-click the toolbar button and choose Options.
3. Paste your Athena address (for example `https://athena.example.com`) and the key, then **Save**. The browser asks for access to that one address. **Test** checks the key works.

## Saving

- **Toolbar button**: saves the page straight away. The window that opens says when it's in Athena, links to it, and takes an optional note.
- **Right-click menu**: Save page, Save selection as a quote, Save image, Save link. A quote keeps the selected text exactly (line breaks, tabs, spacing) along with the page's address and title.
- **Alt+Shift+S**: saves the page without opening anything. Change it at `chrome://extensions/shortcuts` or in Firefox's Manage Extension Shortcuts.

Images: the extension sends the image's address, and Athena fetches it. If the address isn't public (a private network, `localhost`, a `data:` or `blob:` URL, a password in the URL), it also sends a copy of the picture as the page shows it, up to 4 MB.

## When Athena can't be reached

Every save is written to the extension's outbox first, and only leaves it once Athena confirms it. If Athena is down or you're offline, it tries again after 15 seconds, then 1, 5 and 15 minutes, then every hour, and when the browser comes back online. A refused key or a missing setup holds saves until the settings change. The toolbar badge shows how many are waiting (`!` if one needs you). The popup and settings page list them with Retry and Remove. Nothing is dropped unless you remove it.

## Privacy

- Talks to one host: the Athena address you set. The browser grants access to that address only, when you save the settings.
- No analytics, no remote code, no third-party requests.
- The key is kept in the extension's local storage on this device. It isn't synced.
- Permissions: `activeTab` and `scripting` (to read the exact selection or an image, and show the "Saved" note, only on the tab you saved from), `contextMenus`, `storage`, and `alarms` (to retry while the browser is idle).

## Tests

```sh
npm test           # unit: request builder, outbox and retries, settings checks, manifest
npm run test:e2e   # loads dist/chrome-e2e in Chromium (Playwright) against e2e/mock-server.mjs
npm run shots      # the same, and writes screenshots to docs/notes/shots-extension/
npm run test:native  # the real right-click menus and Alt+Shift+S, headed Chromium under Xvfb (needs xvfb-run, xdotool)
npm run test:real  # against a real Athena on 127.0.0.1: set ATHENA_ORIGIN, ATHENA_KEY (capture) and ATHENA_MASTER (app token)
npm run mock       # a mock Athena on http://127.0.0.1:8787 to try the extension by hand
```

The e2e build is the Chrome build plus a host permission for `127.0.0.1`, since a test can't click the browser's permission prompt. Playwright can't open the browser's own menus, so `test:e2e` calls the menu handler directly. `test:native` covers the real thing: it uses the plain Chrome build, right-clicks with the mouse, picks the item with `xdotool`, and checks the save arrived.

Notes and open questions: [docs/notes/save-extension.md](../docs/notes/save-extension.md).

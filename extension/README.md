# Save to Athena

A browser extension that saves the page you're on, a quote, an image or a link to your own Athena. One codebase, Manifest V3, for Chrome, Edge, Firefox and Safari.

This page is for building and testing it. To set it up and use it, see [the browser extension guide](https://athena-community.netlify.app/docs/guide/browser-extension/).

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

Open the generated project in Xcode, pick the macOS scheme, and run it. Then in Safari: Settings → Advanced → turn on "Show features for web developers", Develop → Allow Unsigned Extensions, and turn on Save to Athena under Settings → Extensions. Keep the Xcode project out of this repo; rerun the converter after a rebuild. The Safari build is untested.

## Tests

```sh
npm test           # unit: request builder, outbox and retries, settings checks, manifest
npm run test:e2e   # loads dist/chrome-e2e in Chromium (Playwright) against e2e/mock-server.mjs
npm run shots      # the same, and writes screenshots to shots/extension/ (git-ignored)
npm run test:native  # the real right-click menus and Alt+Shift+S, headed Chromium under Xvfb (needs xvfb-run, xdotool)
npm run test:real  # against a real Athena on 127.0.0.1: set ATHENA_ORIGIN, ATHENA_KEY (capture) and ATHENA_MASTER (app token)
npm run mock       # a mock Athena on http://127.0.0.1:8787 to try the extension by hand
```

The e2e build is the Chrome build plus a host permission for `127.0.0.1`, since a test can't click the browser's permission prompt. Playwright can't open the browser's own menus, so `test:e2e` calls the menu handler directly. `test:native` covers the real thing: it uses the plain Chrome build, right-clicks with the mouse, picks the item with `xdotool`, and checks the save arrived.

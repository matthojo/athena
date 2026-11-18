import { test } from "node:test";
import assert from "node:assert/strict";
import { getMapApp, MAP_APP_KEY, openMapUrl, setMapApp } from "./map-app";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9)";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64)";

function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  return store;
}

test("before a choice, Apple devices open Apple Maps and others OpenStreetMap", () => {
  stubStorage();
  for (const ua of [IPHONE, IPAD, MAC]) assert.equal(getMapApp(ua), "apple", ua);
  for (const ua of [ANDROID, WINDOWS, LINUX, ""]) assert.equal(getMapApp(ua), "osm", ua);
  const spot = { at: { lat: 51.5362, lng: -0.1257 }, query: "Dishoom" };
  assert.equal(openMapUrl(spot, IPHONE), "maps://?ll=51.5362%2C-0.1257&q=Dishoom");
  assert.equal(openMapUrl(spot, WINDOWS), "https://www.openstreetmap.org/?mlat=51.5362&mlon=-0.1257#map=17/51.5362/-0.1257");
});

test("a choice is kept on the device and every Open map uses it", () => {
  const store = stubStorage();
  setMapApp("google");
  assert.equal(store.get(MAP_APP_KEY), "google");
  assert.equal(getMapApp(MAC), "google");
  assert.equal(openMapUrl({ query: "British Museum" }, MAC), "https://www.google.com/maps/search/?api=1&query=British+Museum");
  setMapApp("apple");
  assert.equal(openMapUrl({ query: "British Museum" }, WINDOWS), "https://maps.apple.com/?q=British+Museum", "Apple Maps on the web away from an Apple device");
  setMapApp("osm");
  assert.equal(openMapUrl({ query: "British Museum" }, IPHONE), "https://www.openstreetmap.org/search?query=British+Museum");
});

test("an unknown or unreadable value falls back to the default", () => {
  const store = stubStorage();
  store.set(MAP_APP_KEY, "bing");
  assert.equal(getMapApp(IPHONE), "apple");
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(getMapApp(LINUX), "osm");
  assert.doesNotThrow(() => setMapApp("google"));
});

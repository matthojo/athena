// Run: npx tsx --test lib/static-map.test.ts
// The day map without the database: the zoom that fits the stops, the tiles under it, only tile numbers and
// the key sent to the provider (never a name, id or coordinate), markers in Athena's colours, light and dark
// styles, and a refused key.
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { fitView, MAP_COLOURS, MAP_SCALE, MAP_SIZES, mapDeps, markerPoints, project, PROVIDERS, renderMap, TileKeyRejected, tilesFor, type Stop } from "./static-map";

const DAY: Stop[] = [
  { lat: 51.5568, lng: -0.1517 }, // home, Highgate-ish
  { lat: 51.5246, lng: -0.1340 }, // work
  { lat: 51.5124, lng: -0.1258 }, // lunch
  { lat: 51.5246, lng: -0.1341 }, // back at work: the same marker
  { lat: 51.5568, lng: -0.1517 }, // home again
];

async function tile(rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width: 512, height: 512, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
}

function provider(answer: (url: URL) => Promise<Response>) {
  const urls: URL[] = [];
  mapDeps.fetch = async (input) => {
    const u = new URL(String(input));
    urls.push(u);
    return answer(u);
  };
  mapDeps.assertPublic = async () => undefined;
  return urls;
}

test("projection and fit: every stop inside the frame with room around it", () => {
  const p = project({ lat: 0, lng: 0 }, 0);
  assert.deepEqual([p.x, p.y], [128, 128]);
  const size = MAP_SIZES.card;
  const view = fitView(DAY, size);
  assert.ok(view.z >= 11 && view.z <= 16, `zoom ${view.z}`);
  for (const s of DAY) {
    const q = project(s, view.z);
    assert.ok(q.x - view.left > 20 && view.left + size.w - q.x > 20, "inside horizontally");
    assert.ok(q.y - view.top > 20 && view.top + size.h - q.y > 20, "inside vertically");
  }
  // One zoom closer wouldn't fit.
  const closer = DAY.map((s) => project(s, view.z + 1));
  const bw = Math.max(...closer.map((c) => c.x)) - Math.min(...closer.map((c) => c.x));
  const bh = Math.max(...closer.map((c) => c.y)) - Math.min(...closer.map((c) => c.y));
  assert.ok(bw > size.w * 0.6 || bh > size.h * 0.6);
  assert.equal(fitView([DAY[0]], size).z, 15, "a single stop gets a street-level view");
  // Far apart (London and Paris) zooms right out.
  assert.ok(fitView([DAY[0], { lat: 48.8566, lng: 2.3522 }], size).z <= 7);
});

test("tiles under the view cover it exactly, wrapping across the date line", () => {
  const view = fitView(DAY, MAP_SIZES.card);
  const grid = tilesFor(view);
  assert.ok(grid.cols * 256 >= view.w && grid.rows * 256 >= view.h);
  assert.equal(grid.tiles.length, grid.cols * grid.rows);
  const fiji = tilesFor(fitView([{ lat: -17.7, lng: 179.99 }, { lat: -17.8, lng: -179.99 }], MAP_SIZES.card));
  assert.ok(fiji.tiles.every((t) => t.x >= 0 && t.x < 2 ** t.z));
});

test("repeat visits are one marker", () => {
  assert.equal(markerPoints(DAY, fitView(DAY, MAP_SIZES.card)).length, 3);
});

test("the provider gets tile numbers and the key: no names, ids or coordinates", async () => {
  const grey = await tile([230, 232, 236]);
  const urls = provider(async () => new Response(new Uint8Array(grey), { headers: { "content-type": "image/png" } }));
  const out = await renderMap(DAY, { provider: "maptiler", key: "KEY123", theme: "light", size: "card" });
  assert.ok(urls.length > 0 && urls.length <= 12);
  for (const u of urls) {
    assert.match(u.toString(), /^https:\/\/api\.maptiler\.com\/maps\/dataviz\/256\/\d+\/\d+\/\d+@2x\.png\?key=KEY123$/);
    assert.deepEqual([...u.searchParams.keys()], ["key"]);
    for (const s of DAY) {
      assert.ok(!u.toString().includes(s.lat.toFixed(3)) && !u.toString().includes(String(s.lng).slice(0, 6)), "no coordinates");
    }
  }
  const meta = await sharp(out.image).metadata();
  assert.equal(meta.format, "webp");
  assert.deepEqual([meta.width, meta.height], [MAP_SIZES.card.w * MAP_SCALE, MAP_SIZES.card.h * MAP_SCALE]);
  assert.equal(out.missing, 0);

  // Markers are drawn in Athena's accent at each stop.
  const view = fitView(DAY, MAP_SIZES.card);
  const raw = await sharp(out.image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const accent = MAP_COLOURS.light.accent;
  const want = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16));
  for (const p of markerPoints(DAY, view)) {
    const i = (Math.round(p.y) * raw.info.width + Math.round(p.x)) * 3;
    const got = [raw.data[i], raw.data[i + 1], raw.data[i + 2]];
    assert.ok(got.every((v, k) => Math.abs(v - want[k]) < 14), `marker colour ${got} vs ${want}`);
  }
});

test("dark uses the dark style; Stadia uses its own host and parameter", async () => {
  const dark = await tile([30, 32, 38]);
  const urls = provider(async () => new Response(new Uint8Array(dark)));
  await renderMap(DAY, { provider: "maptiler", key: "k", theme: "dark", size: "card" });
  assert.ok(urls.every((u) => u.pathname.startsWith(`/maps/${PROVIDERS.maptiler.styles.dark}/`)));
  urls.length = 0;
  await renderMap(DAY, { provider: "stadia", key: "s", theme: "dark", size: "full" });
  assert.ok(urls.every((u) => u.host === "tiles.stadiamaps.com" && u.pathname.startsWith("/tiles/alidade_smooth_dark/") && u.searchParams.get("api_key") === "s"));
});

test("a refused key is TileKeyRejected; a missing tile is drawn as plain ground", async () => {
  provider(async () => new Response("no", { status: 403 }));
  await assert.rejects(renderMap(DAY, { provider: "maptiler", key: "bad", theme: "light", size: "card" }), TileKeyRejected);
  let n = 0;
  const grey = await tile([230, 232, 236]);
  provider(async () => (n++ === 0 ? new Response("oops", { status: 500 }) : new Response(new Uint8Array(grey))));
  const out = await renderMap(DAY, { provider: "maptiler", key: "k", theme: "light", size: "card" });
  assert.equal(out.missing, 1);
});

test("only the provider's own host is ever fetched", async () => {
  const urls = provider(async () => new Response(new Uint8Array(await tile([1, 1, 1]))));
  await renderMap([DAY[0]], { provider: "stadia", key: "k", theme: "light", size: "card" });
  assert.ok(urls.every((u) => u.protocol === "https:" && u.host === PROVIDERS.stadia.host));
});

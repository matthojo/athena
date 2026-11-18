import { test } from "node:test";
import assert from "node:assert/strict";
import { smoothPath } from "./day-words";

test("smoothPath passes through every point and never overshoots the range", () => {
  const pts: [number, number][] = [[0, 30], [10, 10], [20, 10], [30, 40], [40, 20]];
  const d = smoothPath(pts);
  assert.ok(d.startsWith("M0.0,30.0"));
  for (const [x, y] of pts.slice(1)) assert.ok(d.includes(`${x.toFixed(1)},${y.toFixed(1)}`));
  // Control points stay within the data's range (monotone: no swing past a day's figure).
  const ys = [...d.matchAll(/[ C](-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[2]));
  assert.ok(Math.min(...ys) >= 10 && Math.max(...ys) <= 40);
  // A flat stretch stays flat.
  assert.ok(d.includes("C13.3,10.0 16.7,10.0 20.0,10.0"));
});

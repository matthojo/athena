// Run: npx tsx --test app/src/db/sample-work.test.ts
// Sample Work reads as one person's real year: titles never repeat within a project, every period has work,
// and the page's own rules (lib/work-stats.ts) shape it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleWork, sampleWorkProject, setSampleWorkToday } from "./sample-work";

test("each project's issues have different titles, and every period has work", () => {
  setSampleWorkToday("2026-11-12");
  const year = sampleWork("year");
  assert.ok(year.projects.length >= 4);
  for (const p of year.projects.filter((x) => x.name !== "No project")) {
    const d = sampleWorkProject(p.name)!;
    const titles = d.issues.map((i) => i.title);
    assert.equal(new Set(titles).size, titles.length, `${p.name}: ${titles.join(" | ")}`);
  }
  for (const id of ["month", "quarter", "year", "2025"]) assert.ok(sampleWork(id).count.issues_closed > 0, id);
  setSampleWorkToday(null);
});

/**
 * Sample Work: a made-up year and a half of one person's issues and pull
 * requests, the same every time for a given date (seeded per day). Weekdays
 * carry the work, with a quiet fortnight in August and over Christmas; a few
 * projects take turns at the front; most issues close in a few days and a
 * few drag on for weeks; most PRs merge the same day. Then a handful of Work
 * activity notes, with one blocker still open. The rows go through the same
 * rules as the server's (lib/work-stats.ts).
 */

import type { WorkItem } from "../../../lib/work";
import { projectDetail, workPage, type WorkData, type WorkNote, type WorkProjectDetail } from "../../../lib/work-stats";

const TZ = "Europe/London";
const pad = (n: number) => String(n).padStart(2, "0");
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
let fixedToday: string | null = null;
/** For the screenshot mocks: pretend today is this date. */
export function setSampleWorkToday(date: string | null): void {
  fixedToday = date;
}
const today = () => fixedToday ?? localToday();
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function seeded(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Projects, and the months each is busiest (1-12): the work moves between them. */
const PROJECTS: Array<{ name: string; peak: number; titles: string[] }> = [
  { name: "Checkout", peak: 10, titles: ["Validate postcodes on the card form", "Show saved cards first", "Retry a declined payment once", "Keep the basket when signing in", "Address lookup on mobile", "Gift messages at checkout", "Split delivery dates"] },
  { name: "Billing", peak: 4, titles: ["Proration for mid-month upgrades", "Invoice PDFs in the account page", "Retry failed webhooks", "VAT numbers on invoices", "Annual plans", "Dunning emails"] },
  { name: "Search", peak: 7, titles: ["Typo tolerance", "Filters keep their state", "Faster first results", "Search in the help centre", "Synonyms for sizes"] },
  { name: "Onboarding", peak: 1, titles: ["Shorter sign-up form", "Invite a teammate in step two", "Sample project for new accounts", "Progress checklist"] },
  { name: "Platform", peak: 12, titles: ["Upgrade the queue worker", "Move cron jobs to the scheduler", "Cut cold starts", "Structured logs", "Feature flags service"] },
];
const REPOS = ["app/web", "app/api", "app/mobile"];
/** What a title gains the second time round, and after: "Address lookup on mobile, for teams". */
const TWISTS = ["", ", follow-up", ", for teams", ", in the API", ", edge cases", ", on tablets", ", accessibility pass", ", clean-up", ", tests", ", copy", ", metrics", ", rollout"];

/** Days off: a fortnight in August, Christmas to New Year. */
function away(d: string): boolean {
  const md = d.slice(5);
  return (md >= "08-10" && md <= "08-23") || md >= "12-23" || md <= "01-02";
}

const at = (day: string, hour: number, minute = 0) => `${day}T${pad(hour)}:${pad(minute)}:00.000Z`;
const plusHours = (iso: string, h: number) => new Date(Date.parse(iso) + h * 3_600_000).toISOString();

function sampleItems(): WorkItem[] {
  const t = today();
  const items: WorkItem[] = [];
  let n = 1;
  let pr = 1;
  const used = new Map<string, number>();
  for (let d = addDays(t, -540); d <= t; d = addDays(d, 1)) {
    const rnd = seeded(`work:${d}`);
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6 || away(d)) continue;
    const month = Number(d.slice(5, 7));
    // A few issues started on a working day, weighted to whichever project is near its peak.
    const starts = rnd() < 0.3 ? 0 : 1 + Math.floor(rnd() * rnd() * 3.5);
    for (let k = 0; k < starts; k++) {
      const weights = PROJECTS.map((p) => 1 + 5 * Math.max(0, 1 - Math.min(Math.abs(p.peak - month), 12 - Math.abs(p.peak - month)) / 3));
      let pick = rnd() * weights.reduce((a, b) => a + b, 0);
      const p = PROJECTS.find((_, i) => (pick -= weights[i]) < 0) ?? PROJECTS[0];
      const started = at(d, 9 + Math.floor(rnd() * 6), Math.floor(rnd() * 60));
      // Most close within days; one in eight drags on for weeks.
      const days = rnd() < 0.12 ? 10 + rnd() * 25 : Math.exp(rnd() * 2.1) - 0.6;
      let done = plusHours(started, Math.max(1.5, days * 24));
      // Nobody closes issues at 3am: move it to the working day.
      const doneDay = done.slice(0, 10);
      const doneDow = new Date(`${doneDay}T12:00:00Z`).getUTCDay();
      if (doneDow === 0 || doneDow === 6) done = at(addDays(doneDay, doneDow === 6 ? 2 : 1), 10 + Math.floor(rnd() * 6));
      const open = done.slice(0, 10) > t;
      const estimate = [1, 1, 2, 2, 3, 3, 5, 8][Math.floor(rnd() * 8)];
      // Each project works through its own list, then the same work again with a twist: titles never repeat within a project.
      const nth = (used.set(p.name, (used.get(p.name) ?? 0) + 1).get(p.name)! - 1);
      const round = Math.floor(nth / p.titles.length);
      const title = `${p.titles[nth % p.titles.length]}${TWISTS[round] ?? ` (round ${round + 1})`}`;
      items.push({
        source: "linear",
        id: `sample-issue-${n}`,
        identifier: `ENG-${1200 + n}`,
        title,
        url: `https://linear.app/sample/issue/ENG-${1200 + n}`,
        project: rnd() < 0.08 ? undefined : p.name,
        team: "Engineering",
        state: open ? (rnd() < 0.5 ? "In Progress" : "In Review") : "Done",
        created: plusHours(started, -24 * (1 + rnd() * 9)),
        started,
        ...(open ? {} : { completed: done }),
        updated: open ? started : done,
        estimate,
      });
      n++;
    }
    // A pull request most working days; most merge the same day.
    if (rnd() < 0.5) {
      const opened = at(d, 10 + Math.floor(rnd() * 6), Math.floor(rnd() * 60));
      const hours = rnd() < 0.6 ? 0.3 + rnd() * 5 : rnd() < 0.8 ? 6 + rnd() * 40 : 48 + rnd() * 140;
      const merged = plusHours(opened, hours);
      const live = merged.slice(0, 10) > t;
      items.push({ source: "github", id: `${REPOS[pr % 3]}#${3400 + pr}`, repo: REPOS[pr % 3 === 2 && rnd() < 0.6 ? 0 : pr % 3], number: 3400 + pr, title: "A change", role: "opened", opened, ...(live ? {} : { merged }), updated: live ? opened : merged, reviews: Math.floor(rnd() * 3) });
      pr++;
    }
    // Merging a teammate's now and then.
    if (rnd() < 0.12) {
      items.push({ source: "github", id: `app/api#${5100 + pr}:merged`, repo: "app/api", number: 5100 + pr, title: "A teammate's change", role: "merged", merged: at(d, 15 + Math.floor(rnd() * 3)) });
      pr++;
    }
    // Reviewing other people's.
    if (rnd() < 0.55) {
      items.push({ source: "github", id: `app/api#${5100 + pr}`, repo: "app/api", number: 5100 + pr, title: "A teammate's change", role: "reviewed", reviewed_at: at(d, 11 + Math.floor(rnd() * 5)) });
      pr++;
    }
  }
  return items;
}

function sampleNotes(): WorkNote[] {
  const t = today();
  return [
    { id: "5a3e0000-0000-4000-8000-0000000007a1", title: "Waiting on sandbox keys from the payments provider", kind: "stuck", open: true, date: addDays(t, -3) },
    { id: "5a3e0000-0000-4000-8000-0000000007a2", title: "Saved cards behind a flag until the audit is done", kind: "decided", open: false, date: addDays(t, -2) },
    { id: "5a3e0000-0000-4000-8000-000000000007", title: "Postcode checks live for everyone", kind: "shipped", open: false, date: addDays(t, -1) },
    { id: "5a3e0000-0000-4000-8000-0000000007a4", title: "Invoice PDFs held up by the template review", kind: "stuck", open: false, date: addDays(t, -9) },
    { id: "5a3e0000-0000-4000-8000-0000000007a5", title: "Typo tolerance shipped to search", kind: "shipped", open: false, date: addDays(t, -12) },
  ];
}

let held: { day: string; items: WorkItem[] } | null = null;
const items = () => {
  const t = today();
  if (held?.day !== t) held = { day: t, items: sampleItems() };
  return held.items;
};

export function sampleWork(period: string | null): WorkData {
  return workPage({ items: items(), notes: sampleNotes(), today: today(), tz: TZ, period, connected: { linear: true, github: true } });
}

export function sampleWorkProject(name: string): WorkProjectDetail | null {
  return projectDetail(items(), name, today(), TZ);
}

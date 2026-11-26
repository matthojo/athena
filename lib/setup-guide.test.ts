// The guided setup's rules (lib/setup-guide.ts) and the site session it can be read with (lib/site-session.ts).
// Run: npx tsx --test lib/setup-guide.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGuideChange, guideReason, inUse, netlifyPage, parseGuideChange, readGuide, siteReady, type SiteChecks } from "./setup-guide";
import { sessionSignature, validSiteSession } from "./site-session";

const READY: SiteChecks = { database: true, data_key: "set", connector_key: true, ai: true, preview: false };

test("a new site is guided until the owner finishes", () => {
  assert.equal(guideReason({ step: null, completed_at: null }, READY, false), "new");
  assert.equal(guideReason({ step: "sources", completed_at: null }, READY, false), "new");
  assert.equal(guideReason({ step: "done", completed_at: "2026-11-26T09:00:00.000Z" }, READY, false), null);
});

test("a finished site is guided again when a required setting goes missing, not when AI does", () => {
  const done = { step: "done" as const, completed_at: "2026-11-26T09:00:00.000Z" };
  assert.equal(guideReason(done, { ...READY, data_key: "missing" }, false), "fix");
  assert.equal(guideReason(done, { ...READY, data_key: "invalid" }, false), "fix");
  assert.equal(guideReason(done, { ...READY, connector_key: false }, false), "fix");
  assert.equal(guideReason(done, { ...READY, database: false }, false), "fix");
  assert.equal(guideReason(done, { ...READY, ai: false }, false), null);
  assert.equal(siteReady({ ...READY, ai: false }), true);
});

test("a deploy preview is never guided, finished or not", () => {
  const preview = { ...READY, data_key: "missing" as const, preview: true };
  assert.equal(guideReason({ step: null, completed_at: null }, preview, false), null);
  assert.equal(guideReason({ step: "done", completed_at: "2026-11-26T09:00:00.000Z" }, preview, true), null);
});

test("a copy in use before the guide existed counts as finished", () => {
  const now = new Date("2026-11-26T12:00:00Z");
  assert.equal(inUse({ notes: 6, connectors: 0, started_at: null }, now), true);
  assert.equal(inUse({ notes: 0, connectors: 1, started_at: null }, now), true);
  assert.equal(inUse({ notes: 0, connectors: 0, started_at: "2026-11-20T08:00:00Z" }, now), true);
  assert.equal(inUse({ notes: 2, connectors: 0, started_at: "2026-11-26T08:00:00Z" }, now), false);
  assert.equal(guideReason({ step: null, completed_at: null }, READY, true), null);
  assert.equal(guideReason({ step: null, completed_at: null }, { ...READY, connector_key: false }, true), "fix");
});

test("progress: stored values are checked, and changes apply", () => {
  assert.deepEqual(readGuide({ step: "nowhere", completed_at: "not a date" }), { step: null, completed_at: null });
  assert.deepEqual(readGuide(null), { step: null, completed_at: null });
  const now = new Date("2026-11-26T12:00:00Z");
  const done = applyGuideChange({ step: "phone", completed_at: null }, { step: "done", complete: true }, now);
  assert.deepEqual(done, { step: "done", completed_at: "2026-11-26T12:00:00.000Z" });
  assert.deepEqual(applyGuideChange(done, { restart: true }, now), { step: null, completed_at: null });
  assert.deepEqual(parseGuideChange({ step: "about" }), { step: "about" });
  assert.throws(() => parseGuideChange({ step: "nowhere" }));
  assert.throws(() => parseGuideChange({ complete: "yes" }));
  assert.throws(() => parseGuideChange({}));
});

test("links into Netlify use the site's name only when it looks like one", () => {
  assert.equal(netlifyPage("athena-example", "env"), "https://app.netlify.com/projects/athena-example/configuration/env");
  assert.equal(netlifyPage("athena-example", "deploys"), "https://app.netlify.com/projects/athena-example/deploys");
  assert.equal(netlifyPage(null, "env"), "https://app.netlify.com/");
  assert.equal(netlifyPage("../evil", "env"), "https://app.netlify.com/");
});

test("a site session is the edge function's cookie, unexpired and signed with SESSION_SECRET for the password", () => {
  const secret = "a".repeat(64);
  const password = "correct horse battery staple";
  const now = new Date("2026-11-26T12:00:00Z");
  const exp = String(Math.floor(now.getTime() / 1000) + 3600);
  const cookie = `other=1; athena_session=${exp}.${sessionSignature(secret, password, exp)}`;
  assert.equal(validSiteSession(cookie, secret, password, now), true);
  assert.equal(validSiteSession(cookie, "b".repeat(64), password, now), false);
  assert.equal(validSiteSession(cookie, secret, "a new password", now), false, "a changed password ends the session");
  assert.equal(validSiteSession(cookie, secret, password, new Date(now.getTime() + 7200_000)), false);
  assert.equal(validSiteSession(`athena_session=${exp}.forged`, secret, password, now), false);
  assert.equal(validSiteSession(cookie, undefined, password, now), false);
  assert.equal(validSiteSession(cookie, secret, undefined, now), false);
  assert.equal(validSiteSession(null, secret, password, now), false);
});

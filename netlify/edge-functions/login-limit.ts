/**
 * A platform rate limit on the login form.
 *
 * site-auth.ts answers every path, so a limit in its config would count
 * every page and file. This function matches only /login and does nothing
 * itself: it exists to carry the rule. Netlify counts requests to the path
 * per IP address and answers 429 past the limit, before any code runs; it
 * can take up to ten seconds to start blocking. The docs don't say whether
 * `method` narrows the count, so the limit leaves room for the form's GET
 * as well as its POST: about five password attempts a minute.
 *
 * Inline declarations on one path run in file-name order, so this runs
 * before site-auth.ts and hands the request on to it.
 *
 * Netlify reads this config statically, so it stays a plain object literal
 * (as in netlify/functions/voice.ts).
 */
export default () => undefined;

export const config = {
  path: "/login",
  method: "POST",
  rateLimit: {
    windowLimit: 10,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
  },
};

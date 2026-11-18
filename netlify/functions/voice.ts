/**
 * /api/voice/* — the same REST API handler as api.ts (same bearer auth, same
 * dispatcher), deployed as its own function only so these paths can carry a
 * platform rate limit: every call spends AI Gateway credits, and a stuck
 * client or a leaked token shouldn't be able to run that up. api.ts excludes
 * /api/voice/* so the two never overlap.
 *
 * 10 recordings a minute per IP is far beyond what a person dictating does.
 * Netlify reads this config statically, so it has to stay a plain object
 * literal — and it isn't annotated as `Config` because @netlify/functions 3.1's
 * RateLimitConfig type lacks `windowLimit`, which the platform requires.
 */
export { default } from "./api";

export const config = {
  path: "/api/voice/*",
  rateLimit: {
    windowLimit: 10,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
  },
};

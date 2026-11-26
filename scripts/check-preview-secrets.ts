/**
 * Stops a deploy preview's or branch deploy's build when it can see a secret meant for production.
 *
 * A preview runs code before anyone merges it: every update arrives as a pull request
 * (scripts/update-athena.sh), and Netlify builds and runs its preview with whatever that context's
 * environment holds. Those values belong to the Production context alone: with them a preview could
 * read the database, sign in as the owner or open account sign-ins. The Deploy to Netlify button sets
 * them for every context, so this build says so, by name and never by value, and how to fix it.
 *
 * Netlify sets CONTEXT on its builds; anywhere else (a local build, CI) this does nothing. It sees only
 * what the build is given: a value scoped to functions alone reaches a preview's functions without
 * this seeing it, which is why the fix it asks for is the context, not the scope.
 * ATHENA_ALLOW_PREVIEW_SECRETS=1 lets the build carry on regardless.
 */
import { fileURLToPath } from "node:url";

export const PRODUCTION_ONLY = [
  "ATHENA_DATA_KEY",
  "ATHENA_DATA_KEY_PREVIOUS",
  "MCP_BEARER_TOKEN",
  "CONNECTOR_ENCRYPTION_KEY",
  "CONNECTOR_ENCRYPTION_KEY_PREVIOUS",
  "SESSION_SECRET",
  "SITE_PASSWORD",
] as const;

const PREVIEW_CONTEXTS = new Set(["deploy-preview", "branch-deploy"]);

/** The production-only names this build can see, when it's a preview's or a branch deploy's. Pure. */
export function previewSecrets(env: Record<string, string | undefined>): string[] {
  if (!PREVIEW_CONTEXTS.has(env.CONTEXT ?? "")) return [];
  return PRODUCTION_ONLY.filter((name) => !!env[name]?.trim());
}

export function message(context: string, names: string[]): string {
  return [
    `This ${context} build can see ${names.join(", ")}.`,
    "A preview runs code before it's merged, so these belong to the Production context alone.",
    "In Netlify: Site configuration → Environment variables → each of these → Edit → Production only",
    "(or `netlify env:set NAME value --context production --secret`). Then retry this deploy.",
    "The preview's login page then says it isn't set up, which is expected: it still shows the build worked.",
    "To build anyway, set ATHENA_ALLOW_PREVIEW_SECRETS=1 for this context.",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = previewSecrets(process.env);
  if (names.length) {
    const text = message(process.env.CONTEXT ?? "preview", names);
    if (process.env.ATHENA_ALLOW_PREVIEW_SECRETS === "1") {
      console.warn(`Warning: ${text}`);
    } else {
      console.error(text);
      process.exit(1);
    }
  }
}

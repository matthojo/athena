/**
 * A skill imported from a link (lib/skills.ts): a GitHub folder, read
 * through GitHub's contents API, or a raw SKILL.md. Fetched once, here on the
 * server, for the preview; saving sends the previewed text back, so nothing
 * is fetched again.
 *
 * The same guard as Saved and artwork (netlify/lib/connectors/icons.ts):
 * https only, every host's addresses checked before and while connecting (no
 * private or internal addresses), no credentials in the link, redirects
 * followed by hand and only on the same host (an off-site redirect is
 * refused), one deadline, a byte cap per response and for the whole import.
 */
import { assertPublicHost, publicFetch } from "../netlify/lib/connectors/icons";
import { intakeEntries, SKILL_LIMITS, SkillFormatError, TEXT_EXTENSIONS, type IntakeEntry, type SkillPreview } from "./skills";

export type SkillLink =
  | { kind: "github"; owner: string; repo: string; ref: string | null; path: string }
  | { kind: "raw"; url: string };

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * What a link points at: a GitHub folder (…/tree/<ref>/<path>, a repo, or a
 * …/blob/…/SKILL.md, read as its folder) or a SKILL.md anywhere else on
 * https. Throws SkillFormatError for anything else. Pure. A branch with a
 * slash in its name isn't supported: the first segment after tree/ is the ref.
 */
export function parseSkillLink(raw: string): SkillLink {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new SkillFormatError("That isn't a link.");
  }
  if (u.protocol !== "https:") throw new SkillFormatError("Only https links can be imported.");
  if (u.username || u.password) throw new SkillFormatError("Leave the sign-in out of the link.");
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (host === "github.com" || host === "www.github.com") {
    const [owner, repo, mode, ref, ...rest] = parts;
    if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo.replace(/\.git$/, ""))) throw new SkillFormatError("That GitHub link doesn't point at a repository.");
    const r = repo.replace(/\.git$/, "");
    if (!mode) return { kind: "github", owner, repo: r, ref: null, path: "" };
    if ((mode !== "tree" && mode !== "blob") || !ref) throw new SkillFormatError("Link to the skill's folder on GitHub, or to its SKILL.md.");
    if (rest.some((p) => p === ".." || p === ".")) throw new SkillFormatError("That GitHub link doesn't point at a folder.");
    let path = rest.join("/");
    if (mode === "blob") {
      if (!/(^|\/)SKILL\.md$/i.test(path)) throw new SkillFormatError("Link to the skill's folder on GitHub, or to its SKILL.md.");
      path = rest.slice(0, -1).join("/");
    }
    return { kind: "github", owner, repo: r, ref, path };
  }
  if (host === "api.github.com") throw new SkillFormatError("Use the folder's address on github.com.");
  return { kind: "raw", url: u.toString() };
}

/** Replaceable in tests: the network and the address check. Production always goes through the guard. */
export const skillFetchDeps = {
  fetch: (input: string | URL, init?: RequestInit) => publicFetch(input, init),
  assertPublic: (url: URL) => assertPublicHost(url),
  timeoutMs: 12_000,
};

const MAX_HOPS = 3;
/** Folders deep inside a skill's folder (references/, assets/…) Athena looks into. */
const MAX_DEPTH = 3;
/** Entries a GitHub folder listing may add up to. */
const MAX_LISTED = 200;

interface Got {
  status: number;
  bytes: Uint8Array;
  type: string;
}

/** One GET through the guard: https, public addresses, same-host redirects only, a byte cap. */
async function get(raw: string, accept: string, maxBytes: number, signal: AbortSignal): Promise<Got> {
  let url = new URL(raw);
  const host = url.hostname.toLowerCase();
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (url.protocol !== "https:" || url.username || url.password) throw new SkillFormatError("Only https links can be imported.");
    if (url.hostname.toLowerCase() !== host) throw new SkillFormatError("That link redirects to another site, so Athena didn't follow it.");
    try {
      await skillFetchDeps.assertPublic(url);
    } catch {
      throw new SkillFormatError("That address is on a private network, which Athena won't connect to.");
    }
    let res: Response;
    try {
      res = await skillFetchDeps.fetch(url, { redirect: "manual", signal, headers: { Accept: accept, "User-Agent": "Athena-personal-notes/1.0 (skill import)" } });
    } catch {
      throw new SkillFormatError(signal.aborted ? "That link took too long to answer." : "Athena couldn't reach that link.");
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!next) throw new SkillFormatError("Athena couldn't reach that link.");
      url = new URL(next, url);
      continue;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, bytes: new Uint8Array(), type: "" };
    }
    if (Number(res.headers.get("content-length") ?? 0) > maxBytes) {
      await res.body.cancel().catch(() => undefined);
      throw new SkillFormatError("That's too big for a skill.");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch {
        throw new SkillFormatError(signal.aborted ? "That link took too long to answer." : "Athena couldn't read that link.");
      }
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SkillFormatError("That's too big for a skill.");
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { status: res.status, bytes, type: (res.headers.get("content-type") ?? "").toLowerCase() };
  }
  throw new SkillFormatError("That link redirects too many times.");
}

const keepable = (path: string) => /(^|\/)skill\.md$/i.test(path) || (TEXT_EXTENSIONS as readonly string[]).some((e) => path.toLowerCase().endsWith(e));

interface GithubItem {
  type: string;
  path: string;
  size?: number;
  download_url?: string | null;
}

/** A GitHub folder's files, through the contents API: text read, everything else listed by name. */
async function githubEntries(link: Extract<SkillLink, { kind: "github" }>, signal: AbortSignal): Promise<IntakeEntry[]> {
  const base = `https://api.github.com/repos/${encodeURIComponent(link.owner)}/${encodeURIComponent(link.repo)}/contents`;
  const list = async (path: string): Promise<GithubItem[]> => {
    const segs = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const at = `${base}${segs ? `/${segs}` : ""}${link.ref ? `?ref=${encodeURIComponent(link.ref)}` : ""}`;
    const got = await get(at, "application/vnd.github+json", 1_000_000, signal);
    if (got.status === 404) throw new SkillFormatError("GitHub couldn't find that folder. Athena only reads public repositories.");
    if (got.status === 403 || got.status === 429) throw new SkillFormatError("GitHub is limiting requests right now. Try again in a few minutes.");
    if (got.status !== 200) throw new SkillFormatError("GitHub didn't answer for that folder.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(got.bytes));
    } catch {
      throw new SkillFormatError("GitHub sent something Athena couldn't read.");
    }
    return (Array.isArray(parsed) ? parsed : [parsed]) as GithubItem[];
  };
  const out: IntakeEntry[] = [];
  let total = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    for (const item of await list(path)) {
      if (out.length >= MAX_LISTED) return;
      const rel = link.path ? item.path.slice(link.path.length).replace(/^\//, "") : item.path;
      if (!rel) continue;
      if (item.type === "dir") {
        if (depth < MAX_DEPTH && !rel.split("/").pop()!.startsWith(".")) await walk(item.path, depth + 1);
        continue;
      }
      if (item.type !== "file") continue;
      const size = Number(item.size ?? 0);
      if (!keepable(rel) || size > SKILL_LIMITS.fileBytes || !item.download_url) {
        out.push({ path: rel, bytes: new Uint8Array(), size: Math.max(size, 1) });
        continue;
      }
      // Files come from GitHub's own raw host, as its listing says, through the same guard.
      const dl = new URL(item.download_url);
      if (dl.hostname !== "raw.githubusercontent.com") {
        out.push({ path: rel, bytes: new Uint8Array(), size: Math.max(size, 1), unread: true });
        continue;
      }
      const got = await get(dl.toString(), "text/plain", SKILL_LIMITS.fileBytes, signal);
      if (got.status !== 200) throw new SkillFormatError(`GitHub didn't send ${rel}.`);
      total += got.bytes.byteLength;
      if (total > SKILL_LIMITS.uploadBytes) throw new SkillFormatError("That's over 2 MB. A skill is mostly text.");
      out.push({ path: rel, bytes: got.bytes });
    }
  };
  await walk(link.path, 0);
  return out;
}

/** Fetch a skill from a link, once, for its preview. Throws SkillFormatError with words for the owner. */
export async function fetchSkillFromLink(raw: string, now = new Date()): Promise<SkillPreview> {
  const link = parseSkillLink(raw);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), skillFetchDeps.timeoutMs);
  try {
    const source = { kind: "link" as const, url: raw.trim(), at: now.toISOString() };
    if (link.kind === "github") return intakeEntries(await githubEntries(link, ctl.signal), source);
    const got = await get(link.url, "text/markdown,text/plain;q=0.9,*/*;q=0.1", SKILL_LIMITS.fileBytes, ctl.signal);
    if (got.status !== 200) throw new SkillFormatError(got.status === 404 ? "Nothing's at that link." : "That link didn't answer.");
    if (/text\/html/.test(got.type)) throw new SkillFormatError("That's a web page, not a SKILL.md. Link to the raw file.");
    return intakeEntries([{ path: "SKILL.md", bytes: got.bytes }], source);
  } finally {
    clearTimeout(timer);
  }
}

/** A public GitHub folder's files, through the same guard, caps and deadline: a workflow's folder (lib/workflow-share.ts). */
export async function fetchGithubFolder(link: Extract<SkillLink, { kind: "github" }>): Promise<IntakeEntry[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), skillFetchDeps.timeoutMs);
  try {
    return await githubEntries(link, ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

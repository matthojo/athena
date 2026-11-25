/**
 * Builds Athena's project website (GitHub Pages) into site/dist.
 *
 * The pages are rendered from the repository's own documents (README, GUIDE,
 * SECURITY, ARCHITECTURE, CONTRIBUTING, CHANGELOG, the extension's README and
 * LICENSE), so the site says what the repository says. The look comes from the
 * app itself: app/src/styles/tokens.css and the app's fonts are copied in, and
 * site/site.css builds on those tokens.
 *
 * Run: npm run site:build   (then npm run site:preview)
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked, Renderer, type Tokens } from "marked";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const OUT = join(SITE, "dist");

/** The repository the site links to. GitHub Actions sets GITHUB_REPOSITORY. */
const REPO = process.env.GITHUB_REPOSITORY || "matthojo/athena";
const REPO_URL = `https://github.com/${REPO}`;
const DEPLOY_URL = `https://app.netlify.com/start/deploy?repository=${REPO_URL}`;
/** The site's own address, for canonical links, social cards and the 404 page. Optional. */
const SITE_URL = process.env.SITE_URL ? process.env.SITE_URL.replace(/\/?$/, "/") : "";

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export type Group = "Start" | "Reference" | "Project";

export interface DocPage {
  slug: string;
  title: string;
  group: Group;
  icon: IconName;
  /** The markdown file it's rendered from, relative to the repository root. */
  file?: string;
  /** README only: the sections (## headings) this page takes. */
  sections?: string[];
  /** One line under the title; README's Documentation list supplies most. */
  lede?: string;
}

export const DOCS: DocPage[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    group: "Start",
    icon: "flag",
    file: "README.md",
    sections: ["Deploy your own", "Use your own keys", "Updating", "Use it from Claude", "Try it locally", "Export to Obsidian"],
    lede: "Deploy your own copy in about ten minutes, then add the accounts and keys you use.",
  },
  { slug: "guide", title: "Guide", group: "Start", icon: "book", file: "GUIDE.md" },
  { slug: "security", title: "Security model", group: "Reference", icon: "shield", file: "SECURITY.md" },
  { slug: "architecture", title: "Architecture", group: "Reference", icon: "graph", file: "ARCHITECTURE.md" },
  { slug: "extension", title: "Browser extension", group: "Reference", icon: "bookmark", file: "extension/README.md" },
  { slug: "raycast", title: "Raycast extension", group: "Reference", icon: "sparkle", file: "raycast/README.md" },
  { slug: "contributing", title: "Contributing", group: "Project", icon: "pen", file: "CONTRIBUTING.md" },
  { slug: "changelog", title: "Changelog", group: "Project", icon: "clock", file: "CHANGELOG.md" },
  { slug: "support", title: "Getting help", group: "Project", icon: "chat", file: "SUPPORT.md" },
  { slug: "governance", title: "Governance", group: "Project", icon: "people", file: "GOVERNANCE.md" },
  {
    slug: "code-of-conduct",
    title: "Code of conduct",
    group: "Project",
    icon: "heart",
    file: "CODE_OF_CONDUCT.md",
    lede: "The Contributor Covenant, which everyone taking part in Athena follows.",
  },
  {
    slug: "trademarks",
    title: "Name and logo",
    group: "Project",
    icon: "tag",
    file: "TRADEMARKS.md",
    lede: "How to use the Athena name and logo, and what a fork should do.",
  },
  { slug: "license", title: "License", group: "Project", icon: "key", file: "LICENSE" },
];

const PAGE_BY_FILE = new Map(DOCS.filter((d) => d.file).map((d) => [d.file!, d]));

// ---------------------------------------------------------------------------
// Icons: the app's own line icons (app/src/components/icons.ts), same grid and stroke
// ---------------------------------------------------------------------------

const ICON_PATHS = {
  notes: `<rect x="5" y="3.5" width="14" height="17" rx="3"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/>`,
  search: `<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>`,
  calendar: `<rect x="4" y="5.5" width="16" height="14.5" rx="3"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>`,
  mail: `<rect x="3.5" y="5.5" width="17" height="13" rx="3"/><path d="m4.5 7.5 7.5 5.5 7.5-5.5"/>`,
  loop: `<path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3l2.2 2.3"/><path d="M19.5 4.5V9H15"/><path d="M19.5 12a7.5 7.5 0 0 1-12.8 5.3l-2.2-2.3"/><path d="M4.5 19.5V15H9"/>`,
  team: `<path d="M5.2 10.2 5 4.5l4.4 3a8.3 8.3 0 0 1 5.2 0l4.4-3-.2 5.7c.8 1.1 1.2 2.4 1.2 3.8 0 3.9-3.6 6.5-8 6.5s-8-2.6-8-6.5c0-1.4.4-2.7 1.2-3.8z"/><circle cx="9.3" cy="13" r="1" fill="currentColor" stroke="none"/><circle cx="14.7" cy="13" r="1" fill="currentColor" stroke="none"/><path d="M11.2 15.4h1.6L12 16.3zM12 16.3v.6c-.4.6-1 .8-1.6.6M12 16.9c.4.6 1 .8 1.6.6"/>`,
  bell: `<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>`,
  mic: `<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.8 11.5a6.2 6.2 0 0 0 12.4 0M12 17.7v2.8"/>`,
  wifiOff: `<path d="M3 3l18 18"/><path d="M8.5 16.3a5 5 0 0 1 7 0"/><path d="M5.3 13a9.2 9.2 0 0 1 2.9-2"/><path d="M12.2 7.8a9.2 9.2 0 0 1 6.5 2.7"/><circle cx="12" cy="19.5" r="1" fill="currentColor" stroke="none"/>`,
  plug: `<path d="M9 3.5v4M15 3.5v4M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0zM12 16.5v4"/>`,
  shield: `<path d="M12 3.5 5 6.3v5.2c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6.3z"/><path d="m9.2 12 2 2 3.8-3.9"/>`,
  key: `<circle cx="8" cy="15" r="4"/><path d="m10.9 12.1 8.6-8.6M16.5 6.5l2.5 2.5M14 9l2 2"/>`,
  book: `<path d="M5 18.5V6A2 2 0 0 1 7 4h12v13H7a2 2 0 0 0-2 2 1.5 1.5 0 0 0 1.5 1.5H19"/><path d="M9 8h6"/>`,
  chevronRight: `<path d="M9.5 5.5 16 12l-6.5 6.5"/>`,
  chevronLeft: `<path d="M14.5 5.5 8 12l6.5 6.5"/>`,
  arrowUp: `<path d="M12 19V5M6 11l6-6 6 6"/>`,
  arrowRight: `<path d="M5 12h14M13 6l6 6-6 6"/>`,
  people: `<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.6-3 2.6-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/><circle cx="17" cy="8" r="2.3"/><path d="M15.5 14.3c2.2.2 3.6 1.6 4 4"/>`,
  check: `<path d="M5 12.5l4.5 4.5L19 7.5"/>`,
  flag: `<path d="M5.5 20.5v-16"/><path d="M5.5 5h11.3l-2.3 3.8 2.3 3.7H5.5"/>`,
  pen: `<path d="M4.5 19.5l1-4.2L15.6 5.2a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.7 18.5z"/><path d="M13.5 7.3l3.2 3.2"/>`,
  clock: `<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>`,
  bookmark: `<path d="M7 4.5h10a1 1 0 0 1 1 1v14.5l-6-4-6 4V5.5a1 1 0 0 1 1-1z"/>`,
  graph: `<circle cx="12" cy="5.5" r="2.2"/><circle cx="5.5" cy="17.5" r="2.2"/><circle cx="18.5" cy="17.5" r="2.2"/><path d="M11 7.5 6.5 15.5M13 7.5l4.5 8M7.7 17.5h8.6"/>`,
  sparkle: `<path d="M12 4.5l1.5 4.2 4.2 1.5-4.2 1.5L12 16l-1.5-4.3-4.2-1.5 4.2-1.5z"/><path d="M18 15.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z"/>`,
  menu: `<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>`,
  close: `<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`,
  copy: `<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>`,
  home: `<path d="M4 10.6 12 4l8 6.6V19a1.5 1.5 0 0 1-1.5 1.5H15v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5H5.5A1.5 1.5 0 0 1 4 19z"/>`,
  github: `<path d="M9 19.5c-4 1.2-4-2-5.5-2.5M14.5 21v-3.2c0-1 .1-1.4-.5-2 2.6-.3 5.3-1.3 5.3-5.8a4.5 4.5 0 0 0-1.2-3.1 4.2 4.2 0 0 0-.1-3.1s-1-.3-3.2 1.2a11 11 0 0 0-5.8 0C6.8 3.5 5.8 3.8 5.8 3.8a4.2 4.2 0 0 0-.1 3.1A4.5 4.5 0 0 0 4.5 10c0 4.5 2.7 5.5 5.3 5.8-.6.6-.6 1.2-.5 2V21"/>`,
  info: `<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.1"/>`,
  chat: `<path d="M5 18.5V7.5A2.5 2.5 0 0 1 7.5 5h9A2.5 2.5 0 0 1 19 7.5v6a2.5 2.5 0 0 1-2.5 2.5H8.2z"/><path d="M9 10h6M9 12.8h3.5"/>`,
  heart: `<path d="M12 19.5s-7-4.2-7-9.3A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.2c0 5.1-7 9.3-7 9.3z"/>`,
  tag: `<path d="M3.8 12.2V5.5a1.7 1.7 0 0 1 1.7-1.7h6.7l8 8a1.7 1.7 0 0 1 0 2.4l-6.3 6.3a1.7 1.7 0 0 1-2.4 0z"/><circle cx="8.3" cy="8.3" r="1.3"/>`,
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function icon(name: IconName, cls = ""): string {
  return `<svg${cls ? ` class="${cls}"` : ""} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}

/** The Athena mark (app/src/components/brand-mark.ts). */
const BRAND_MARK = `<svg class="brand-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 6.2 6.2 16.8M12 6.2l5.8 10.6M6.2 16.8h11.6" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.6" stroke-linecap="round"/><circle class="brand-mark__accent" cx="12" cy="6.2" r="2.7"/><circle cx="6.2" cy="16.8" r="2.7" fill="currentColor"/><circle cx="17.8" cy="16.8" r="2.7" fill="currentColor"/></svg>`;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ""));
}

/** GitHub's heading anchors (github-slugger), so links written for GitHub still land. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

/** Unique anchors within one page, numbered the way GitHub numbers repeats. */
export class Slugger {
  private seen = new Map<string, number>();
  slug(text: string): string {
    const base = slugify(text);
    let id = base;
    let n = this.seen.get(base) ?? 0;
    while (this.seen.has(id)) id = `${base}-${++n}`;
    this.seen.set(base, n);
    this.seen.set(id, 0);
    return id;
  }
}

// ---------------------------------------------------------------------------
// Links: a repository path becomes a page on this site, or the file on GitHub
// ---------------------------------------------------------------------------

/** README anchors that live on the Getting started page; the rest are on the home page. */
const readmeAnchorsOnGettingStarted = new Set<string>();

export function resolveHref(href: string, fromFile: string, root = ROOT): string {
  // README's own anchors follow their section to Getting started (it works from that page too).
  if (fromFile === "README.md" && href.startsWith("#") && readmeAnchorsOnGettingStarted.has(href.slice(1))) {
    return `getting-started.html${href}`;
  }
  if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return href;
  const hashAt = href.indexOf("#");
  const path = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const hash = hashAt >= 0 ? href.slice(hashAt) : "";
  // Already a page on this site.
  if (!path || /\.html$/.test(path)) return href;
  const repoPath = posix.normalize(posix.join(posix.dirname(fromFile), decodeURI(path))).replace(/^\.\//, "");
  if (repoPath.startsWith("..")) return href;

  if (repoPath === "README.md") {
    const anchor = hash.slice(1);
    if (!anchor) return "index.html";
    return readmeAnchorsOnGettingStarted.has(anchor) ? `getting-started.html${hash}` : `index.html${hash}`;
  }
  const page = PAGE_BY_FILE.get(repoPath);
  if (page) return `${page.slug}.html${hash}`;

  const abs = join(root, repoPath);
  const isDir = repoPath.endsWith("/") || (existsSync(abs) && statSync(abs).isDirectory());
  return `${REPO_URL}/${isDir ? "tree" : "blob"}/main/${repoPath.replace(/\/$/, "")}${hash}`;
}

/** Images in the repository are copied into the site; this maps them to their new place. */
const copiedMedia = new Map<string, string>();

function mediaSrc(src: string, fromFile: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return src;
  const repoPath = posix.normalize(posix.join(posix.dirname(fromFile), src));
  const abs = join(ROOT, repoPath);
  if (!existsSync(abs)) return `${REPO_URL}/raw/main/${repoPath}`;
  const out = `assets/media/${basename(repoPath)}`;
  copiedMedia.set(abs, out);
  return out;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export interface Heading {
  depth: number;
  id: string;
  text: string;
}

export interface Rendered {
  html: string;
  headings: Heading[];
  title?: string;
}

const ALERTS: Record<string, string> = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

/** A light touch for shell snippets: comments in a quieter ink. */
function highlight(code: string, lang: string): string {
  const escaped = escapeHtml(code);
  if (!/^(sh|bash|shell|zsh|console)$/.test(lang)) return escaped;
  return escaped
    .split("\n")
    .map((line) => line.replace(/(^|\s)(#(?![!{]).*)$/, (_, pre, c) => `${pre}<span class="c">${c}</span>`))
    .join("\n");
}

export function renderMarkdown(md: string, fromFile: string, opts: { changelog?: boolean } = {}): Rendered {
  const slugger = new Slugger();
  const headings: Heading[] = [];
  let title: string | undefined;
  const base = new Renderer();

  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading(this: Renderer, { tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const text = stripTags(inner).trim();
        if (depth === 1 && title === undefined) {
          title = text;
          return "";
        }
        const id = slugger.slug(text);
        if (depth <= 3) headings.push({ depth, id, text });
        let extra = "";
        if (opts.changelog && depth === 2 && /^\d+\.\d+\.\d+$/.test(text)) {
          extra = ` <a class="chip chip--link" href="${REPO_URL}/releases/tag/v${text}" rel="noopener">${icon("github")}Release v${text}</a>`;
        }
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${inner}${extra}</h${depth}>\n`;
      },
      link(this: Renderer, { href, title: t, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const target = resolveHref(href, fromFile);
        const external = /^https?:/.test(target);
        return `<a href="${escapeHtml(target)}"${t ? ` title="${escapeHtml(t)}"` : ""}${external ? ' rel="noopener"' : ""}>${inner}</a>`;
      },
      image({ href, title: t, text }: Tokens.Image) {
        return `<img src="${escapeHtml(mediaSrc(href, fromFile))}" alt="${escapeHtml(text)}"${t ? ` title="${escapeHtml(t)}"` : ""} loading="lazy">`;
      },
      code({ text, lang }: Tokens.Code) {
        const l = (lang || "").trim().split(/\s+/)[0] || "";
        return `<div class="code">${l ? `<span class="code__lang">${escapeHtml(l)}</span>` : ""}<button class="code__copy" type="button" aria-label="Copy">${icon("copy")}<span>Copy</span></button><pre><code${l ? ` class="language-${escapeHtml(l)}"` : ""}>${highlight(text, l)}</code></pre></div>\n`;
      },
      blockquote(this: Renderer, { tokens }: Tokens.Blockquote) {
        const body = this.parser.parse(tokens);
        const m = body.match(/^<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/);
        if (!m) return `<blockquote>\n${body}</blockquote>\n`;
        const kind = m[1];
        return `<div class="callout callout--${kind.toLowerCase()}"><p class="callout__title">${icon("info")}${ALERTS[kind]}</p><p>${body.slice(m[0].length)}</div>\n`;
      },
      table(this: Renderer, token: Tokens.Table) {
        return `<div class="table-wrap">${base.table.call(this, token)}</div>\n`;
      },
      html({ text }: Tokens.HTML | Tokens.Tag) {
        // Raw HTML in the docs: keep it, pointing images at the copied media.
        return text.replace(/(<img[^>]*\ssrc=")([^"]+)(")/g, (_, a, src, b) => `${a}${mediaSrc(src, fromFile)}${b}`);
      },
    },
  });

  const html = marked.parse(md, { async: false }) as string;
  return { html, headings, title };
}

// ---------------------------------------------------------------------------
// README: pieces the home page and Getting started are built from
// ---------------------------------------------------------------------------

/** Splits markdown into its ## sections, ignoring headings inside code fences. */
export function sections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && line.match(/^## (.+)$/);
    if (m) {
      if (current) out.set(current, buf.join("\n").trim());
      current = m[1].trim();
      buf = [];
    } else if (current) buf.push(line);
  }
  if (current) out.set(current, buf.join("\n").trim());
  return out;
}

export interface Item {
  title: string;
  body: string;
}

/** `- **Title:** text` list items, as title and markdown body. */
export function boldLeadItems(md: string): Item[] {
  const items: Item[] = [];
  for (const token of new Marked().lexer(md)) {
    if (token.type !== "list") continue;
    for (const item of (token as Tokens.List).items) {
      const text = item.text.replace(/\s*\n\s*/g, " ").trim();
      const m = text.match(/^\*\*(.+?):?\*\*:?\s*([\s\S]*)$/);
      if (!m) continue;
      const body = m[2].trim();
      items.push({ title: m[1].replace(/:$/, ""), body: body.charAt(0).toUpperCase() + body.slice(1) });
    }
  }
  return items;
}

/** `- [FILE](FILE): what it is` list items from README's Documentation section. */
export function docBlurbs(md: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of md.split(/\n(?=- )/)) {
    const m = item.match(/^- \[[^\]]+\]\(([^)]+)\):\s*([\s\S]*)$/);
    if (!m) continue;
    const text = m[2].replace(/\s*\n\s*/g, " ").trim();
    out.set(m[1], text.charAt(0).toUpperCase() + text.slice(1));
  }
  return out;
}

export interface Shot {
  src: string;
  alt: string;
}

/** The screenshots README shows, in order, with their descriptions. */
export function screenshots(md: string): Shot[] {
  return [...md.matchAll(/<img src="(\.github\/readme\/[^"]+\.(?:webp|png|jpe?g))"[^>]*\balt="([^"]+)"/g)].map((m) => ({
    src: m[1],
    alt: m[2],
  }));
}

function inline(md: string, fromFile: string): string {
  return renderMarkdown(md, fromFile).html.trim().replace(/^<p>([\s\S]*)<\/p>$/, "$1");
}

function firstCodeBlock(md: string): string | undefined {
  return md.match(/```[a-z]*\n([\s\S]*?)```/)?.[1];
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface Meta {
  title: string;
  description: string;
  path: string;
}

function head(meta: Meta, base = ""): string {
  const canonical = SITE_URL ? `${SITE_URL}${meta.path === "index.html" ? "" : meta.path}` : "";
  const social = canonical
    ? `<link rel="canonical" href="${canonical}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE_URL}assets/media/home.webp">
<meta name="twitter:card" content="summary_large_image">
`
    : "";
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${base ? `<base href="${escapeHtml(base)}">\n` : ""}<title>${escapeHtml(meta.title)}</title>
<meta name="description" content="${escapeHtml(meta.description)}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f4f6f8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0c0e13" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Athena">
<meta property="og:title" content="${escapeHtml(meta.title)}">
<meta property="og:description" content="${escapeHtml(meta.description)}">
${social}<link rel="icon" type="image/png" sizes="32x32" href="assets/icons/favicon-32.png">
<link rel="apple-touch-icon" href="assets/icons/apple-touch-icon-180.png">
<link rel="preload" href="assets/fonts/geist-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="assets/fonts/funnel-display-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="assets/tokens.css">
<link rel="stylesheet" href="assets/site.css">
<script src="assets/site.js" defer></script>
</head>`;
}

const AURORA = `<div class="aurora" aria-hidden="true"><span></span><span></span></div>`;

function searchDialog(): string {
  return `<dialog class="search" aria-label="Search the docs">
  <form method="dialog" class="search__box" role="search">
    ${icon("search")}
    <input class="search__input" type="search" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off" spellcheck="false">
    <kbd>Esc</kbd>
  </form>
  <ol class="search__results" role="listbox" aria-label="Results"></ol>
  <p class="search__empty" hidden>Nothing matches that. Try fewer words.</p>
</dialog>`;
}

function footer(version: string): string {
  const docLinks = DOCS.map((d) => `<li><a href="${d.slug}.html">${escapeHtml(d.title)}</a></li>`).join("");
  return `<footer class="site-footer">
  <div class="site-footer__inner">
    <div class="site-footer__brand">
      <a class="brand" href="index.html">${BRAND_MARK}<span class="brand-name">Athena</span></a>
      <p>A personal second brain that you host yourself, on your own Netlify site.</p>
      <p class="site-footer__meta">Version ${escapeHtml(version)} · Free software under the AGPL-3.0 or later.</p>
    </div>
    <nav aria-label="Documentation"><p class="side-label">Documentation</p><ul>${docLinks}</ul></nav>
    <nav aria-label="Project"><p class="side-label">Project</p><ul>
      <li><a href="${REPO_URL}" rel="noopener">Source on GitHub</a></li>
      <li><a href="${REPO_URL}/releases" rel="noopener">Releases</a></li>
      <li><a href="${REPO_URL}/discussions" rel="noopener">Discussions</a></li>
      <li><a href="${REPO_URL}/issues" rel="noopener">Issues</a></li>
      <li><a href="${REPO_URL}/security/advisories/new" rel="noopener">Report a vulnerability</a></li>
      <li><a href="${DEPLOY_URL}" rel="noopener">Deploy to Netlify</a></li>
    </ul></nav>
  </div>
  <p class="site-footer__note">Screens on this site come from sample mode. Every person and number in them is made up.</p>
</footer>`;
}

function sidebar(current: string, version: string): string {
  const groups: Group[] = ["Start", "Reference", "Project"];
  const items = groups
    .map((g) => {
      const links = DOCS.filter((d) => d.group === g)
        .map(
          (d) =>
            `<a class="side-item" href="${d.slug}.html"${d.slug === current ? ' aria-current="page"' : ""}>${icon(d.icon)}<span class="side-item__label">${escapeHtml(d.title)}</span></a>`
        )
        .join("");
      return `<p class="side-label">${g}</p>${links}`;
    })
    .join("");
  return `<nav class="sidebar" id="sidebar" aria-label="Documentation">
  <a class="sidebar__brand brand" href="index.html">${BRAND_MARK}<span class="brand-name">Athena</span><span class="sidebar__version">v${escapeHtml(version)}</span></a>
  <button class="sidebar__search" type="button" data-search>${icon("search")}<span>Search the docs…</span><kbd>⌘K</kbd></button>
  <a class="btn btn--ink sidebar__new" href="${DEPLOY_URL}" rel="noopener">${icon("arrowUp")}Deploy your own</a>
  <a class="side-item" href="index.html">${icon("home")}<span class="side-item__label">Home</span></a>
  ${items}
  <div class="side-status">
    <p class="side-status__title"><span class="dot"></span>Open source</p>
    <p class="side-status__body">AGPL-3.0. Issues, ideas and pull requests welcome.</p>
    <a class="btn btn--ink btn--sm" href="${REPO_URL}" rel="noopener">${icon("github")}GitHub</a>
  </div>
</nav>`;
}

function topbar(): string {
  return `<header class="topbar">
  <a class="brand" href="index.html">${BRAND_MARK}<span class="brand-name">Athena</span></a>
  <div class="topbar__actions">
    <button class="icon-btn" type="button" data-search aria-label="Search the docs">${icon("search")}</button>
    <button class="icon-btn" type="button" data-menu aria-controls="sidebar" aria-expanded="false" aria-label="Menu">${icon("menu")}</button>
  </div>
</header>`;
}

function toc(headings: Heading[]): string {
  const hs = headings.filter((h) => h.depth === 2 || h.depth === 3);
  if (hs.length < 2) return "";
  const items = hs.map((h) => `<li class="toc__item toc__item--${h.depth}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`).join("");
  return `<aside class="toc" aria-label="On this page"><p class="side-label">On this page</p><ol>${items}</ol></aside>`;
}

function pager(slug: string): string {
  const i = DOCS.findIndex((d) => d.slug === slug);
  const card = (d: DocPage | undefined, dir: "prev" | "next") =>
    d
      ? `<a class="pager__card pager__card--${dir}" href="${d.slug}.html"><span class="pager__dir">${dir === "prev" ? `${icon("chevronLeft")}Previous` : `Next${icon("chevronRight")}`}</span><span class="pager__title">${escapeHtml(d.title)}</span></a>`
      : "<span></span>";
  return `<nav class="pager" aria-label="More docs">${card(DOCS[i - 1], "prev")}${card(DOCS[i + 1], "next")}</nav>`;
}

function docPage(doc: DocPage, body: string, headings: Heading[], version: string): string {
  const words = stripTags(body).split(/\s+/).length;
  const minutes = Math.max(1, Math.round(words / 230));
  const source = doc.file
    ? `<a class="chip chip--link" href="${REPO_URL}/blob/main/${doc.file}" rel="noopener">${icon("github")}${escapeHtml(doc.file)}</a>`
    : "";
  const description = doc.lede || `${doc.title}: Athena's documentation.`;
  return `${head({ title: `${doc.title} · Athena`, description, path: `${doc.slug}.html` })}
<body class="page-docs">
<a class="skip" href="#content">Skip to content</a>
${AURORA}
${topbar()}
<div class="shell">
  ${sidebar(doc.slug, version)}
  <div class="scrim" data-menu-close hidden></div>
  <main class="main" id="content">
    <article class="doc">
      <header class="doc__head">
        <p class="eyebrow">${doc.group}</p>
        <h1 class="doc__title">${escapeHtml(doc.title)}</h1>
        ${doc.lede ? `<p class="doc__lede">${escapeHtml(doc.lede)}</p>` : ""}
        <div class="chips"><span class="chip">${icon("clock")}${minutes} min read</span>${source}</div>
      </header>
      <div class="prose">
${body}
      </div>
      ${pager(doc.slug)}
    </article>
    ${toc(headings)}
  </main>
</div>
${footer(version)}
${searchDialog()}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// The home page
// ---------------------------------------------------------------------------

const FEATURE_ICONS: [RegExp, IconName][] = [
  [/notes|people/i, "notes"],
  [/^ask/i, "sparkle"],
  [/days/i, "calendar"],
  [/collect/i, "mail"],
  [/flows/i, "loop"],
  [/team/i, "team"],
  [/brief|remind/i, "bell"],
  [/voice/i, "mic"],
  [/offline/i, "wifiOff"],
  [/tools|open/i, "plug"],
];

function featureIcon(title: string): IconName {
  return FEATURE_ICONS.find(([re]) => re.test(title))?.[1] ?? "sparkle";
}

function homePage(readme: string, version: string): string {
  const s = sections(readme);
  const features = boldLeadItems(s.get("What it does") ?? "");
  const privacySection = s.get("Your data stays on your site") ?? "";
  const privacy = boldLeadItems(privacySection);
  const privacyAfter = privacySection.split(/\n\n(?=[^-\s])/).slice(1).join("\n\n");
  const [hero, ...phones] = screenshots(readme);
  const blurbs = docBlurbs(s.get("Documentation") ?? "");
  const deploy = s.get("Deploy your own") ?? "";
  const deployIntro = deploy.split(/\n### /)[0].trim();
  const steps = [...deploy.matchAll(/^### (\d+)\. (.+)$/gm)].map((m) => ({ n: m[1], title: m[2] }));
  const tryLocally = s.get("Try it locally") ?? "";
  const tryCode = firstCodeBlock(tryLocally) ?? "";
  const tryAfter = tryLocally.split("```").slice(2).join("```").trim().split("\n\n")[0];
  const license = s.get("License") ?? "";

  const featureCards = features
    .map(
      (f) => `<li class="feature">
        <span class="feature__icon">${icon(featureIcon(f.title))}</span>
        <h3 class="feature__title">${inline(f.title, "README.md")}</h3>
        <p class="feature__body">${inline(f.body, "README.md")}</p>
      </li>`
    )
    .join("");

  const phoneShots = phones
    .map(
      (p) => `<figure class="shot">
        <img src="${mediaSrc(p.src, "README.md")}" alt="${escapeHtml(p.alt)}" loading="lazy">
        <figcaption>${escapeHtml(p.alt.split(":")[0])}</figcaption>
      </figure>`
    )
    .join("");

  const privacyItems = privacy
    .map((p) => {
      const caveat = /^not\b/i.test(p.title);
      return `<li class="promise${caveat ? " promise--caveat" : ""}">
        <span class="promise__icon">${icon(caveat ? "info" : "check")}</span>
        <div><h3>${inline(p.title, "README.md")}</h3><p>${inline(p.body, "README.md")}</p></div>
      </li>`;
    })
    .join("");

  const stepItems = steps
    .map(
      (st) => `<li><a class="step" href="getting-started.html#${slugify(`${st.n}. ${st.title}`)}">
        <span class="step__n">${st.n}</span><span class="step__title">${escapeHtml(st.title)}</span>${icon("chevronRight")}
      </a></li>`
    )
    .join("");

  const docCards = DOCS.filter((d) => !["license", "code-of-conduct", "trademarks"].includes(d.slug))
    .map((d) => {
      const text = (d.file ? blurbs.get(d.file) : undefined) || d.lede || "";
      return `<li><a class="doc-card" href="${d.slug}.html">
        <span class="feature__icon">${icon(d.icon)}</span>
        <span class="doc-card__title">${escapeHtml(d.title)}</span>
        <span class="doc-card__body">${escapeHtml(text)}</span>
      </a></li>`;
    })
    .join("");

  const latest = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8").match(/^## \d+\.\d+\.\d+\s*\n+([^\n]+)/m)?.[1]?.replace(/\.$/, "");
  const description =
    "A personal second brain that you host yourself, on your own Netlify site. Notes, people, to-dos and days in one database, with Claude to answer questions about all of it.";

  return `${head({ title: "Athena · A second brain you host yourself", description, path: "index.html" })}
<body class="page-home">
<a class="skip" href="#content">Skip to content</a>
${AURORA}
<header class="site-nav">
  <div class="site-nav__inner">
    <a class="brand" href="index.html">${BRAND_MARK}<span class="brand-name">Athena</span></a>
    <nav class="site-nav__links" aria-label="Site">
      <a href="getting-started.html">Get started</a>
      <a href="guide.html">Guide</a>
      <a href="security.html">Security</a>
      <a href="changelog.html">Changelog</a>
    </nav>
    <div class="site-nav__actions">
      <button class="icon-btn" type="button" data-search aria-label="Search the docs">${icon("search")}</button>
      <a class="icon-btn" href="${REPO_URL}" rel="noopener" aria-label="Athena on GitHub">${icon("github")}</a>
      <a class="btn btn--ink btn--sm site-nav__deploy" href="${DEPLOY_URL}" rel="noopener">Deploy</a>
    </div>
  </div>
</header>

<main id="content">
  <section class="hero">
    <a class="pill-note" href="changelog.html"><span class="dot"></span><span>Version ${escapeHtml(version)}${latest ? `: ${escapeHtml(latest)}` : ""}</span>${icon("chevronRight")}</a>
    <h1 class="hero__title">A second brain you host yourself. <span class="quiet">Notes, people, to‑dos and days, on a Netlify site you own.</span></h1>
    <p class="hero__lede">Athena collects from the accounts you connect, such as Gmail, Calendar, Slack and Linear, and Claude answers questions about all of it, with sources. Each copy belongs to one person, so the project never sees your data.</p>

    <div class="ask" aria-hidden="true">
      <span class="orb"></span>
      <span class="ask__text"><span class="ask__typed" data-typed>What did Gayle say about pricing last month?</span><span class="ask__caret"></span></span>
      <span class="ask__send">${icon("arrowUp")}</span>
    </div>

    <div class="hero__actions">
      <a class="btn btn--ink btn--lg" href="${DEPLOY_URL}" rel="noopener">${icon("arrowUp")}Deploy to Netlify</a>
      <a class="btn btn--outline btn--lg" href="getting-started.html">Read the docs</a>
      <a class="btn btn--ghost btn--lg" href="${REPO_URL}" rel="noopener">${icon("github")}View the source</a>
    </div>
    <ul class="chips hero__chips" aria-label="Project facts">
      <li class="chip">AGPL-3.0</li><li class="chip">Runs on Netlify</li><li class="chip">Node 24</li><li class="chip">MCP server</li><li class="chip">Works offline</li>
    </ul>
  </section>

  ${
    hero
      ? `<figure class="hero-shot">
    <img src="${mediaSrc(hero.src, "README.md")}" alt="${escapeHtml(hero.alt)}" width="2720" height="1720">
  </figure>`
      : ""
  }

  <section class="band" id="what-it-does" aria-labelledby="what-it-does-title">
    <header class="band__head">
      <p class="eyebrow">What it does</p>
      <h2 class="band__title" id="what-it-does-title">Everything links up, <span class="quiet">and Ask answers from all of it with sources.</span></h2>
    </header>
    <ul class="features">${featureCards}</ul>
    <p class="band__more"><a class="link-arrow" href="guide.html">The guide goes through each of these in detail${icon("arrowRight")}</a></p>
  </section>

  ${
    phoneShots
      ? `<section class="band band--flush" aria-labelledby="screens-title">
    <header class="band__head">
      <p class="eyebrow">On your phone</p>
      <h2 class="band__title" id="screens-title">Installs as an app on your phone, <span class="quiet">and keeps working offline.</span></h2>
    </header>
    <div class="shots" tabindex="0" role="group" aria-label="Screens from sample mode">${phoneShots}</div>
  </section>`
      : ""
  }

  <section class="band" id="your-data-stays-on-your-site" aria-labelledby="privacy-title">
    <div class="panel panel--sunken privacy">
      <header class="privacy__head">
        <p class="eyebrow">Your data stays on your site</p>
        <h2 class="band__title" id="privacy-title">Your own database and keys, <span class="quiet">on your own Netlify account.</span></h2>
        <div class="split__text">${renderMarkdown(privacyAfter, "README.md").html}</div>
        <a class="btn btn--outline" href="security.html">${icon("shield")}Read the security model</a>
      </header>
      <ul class="promises">${privacyItems}</ul>
    </div>
  </section>

  <section class="band" id="deploy-your-own" aria-labelledby="deploy-title">
    <div class="split">
      <div>
        <p class="eyebrow">Deploy your own</p>
        <h2 class="band__title" id="deploy-title">Your own copy in about ten minutes. <span class="quiet">Netlify sets up the site and its database.</span></h2>
        <div class="split__text">${renderMarkdown(deployIntro, "README.md").html}</div>
        <div class="hero__actions">
          <a class="btn btn--ink" href="${DEPLOY_URL}" rel="noopener">${icon("arrowUp")}Deploy to Netlify</a>
          <a class="btn btn--outline" href="getting-started.html">Setup guide</a>
        </div>
      </div>
      <ol class="steps">${stepItems}</ol>
    </div>
  </section>

  <section class="band" id="try-it-locally" aria-labelledby="try-title">
    <div class="split">
      <div>
        <p class="eyebrow">Try it locally</p>
        <h2 class="band__title" id="try-title">Try sample mode first. <span class="quiet">It runs in your browser on made-up data.</span></h2>
        <div class="split__text">${renderMarkdown(tryAfter, "README.md").html}</div>
      </div>
      <div>${renderMarkdown("```sh\n" + tryCode + "```", "README.md").html}</div>
    </div>
  </section>

  <section class="band" id="documentation" aria-labelledby="docs-title">
    <header class="band__head">
      <p class="eyebrow">Documentation</p>
      <h2 class="band__title" id="docs-title">How it works, <span class="quiet">down to which tables are encrypted.</span></h2>
    </header>
    <ul class="doc-cards">${docCards}</ul>
  </section>

  <section class="band" id="contributing" aria-labelledby="community-title">
    <div class="panel community" id="license">
      <div>
        <p class="eyebrow">Open source</p>
        <h2 class="band__title" id="community-title">Free software <span class="quiet">under the AGPL.</span></h2>
        <div class="split__text">${renderMarkdown(license, "README.md").html}</div>
      </div>
      <div class="community__actions">
        <a class="row-link" href="contributing.html">${icon("pen")}<span><strong>Contribute</strong><span>Setup, checks, and the rules every change follows</span></span>${icon("chevronRight")}</a>
        <a class="row-link" href="support.html">${icon("chat")}<span><strong>Get help</strong><span>Questions in Discussions, bugs in issues</span></span>${icon("chevronRight")}</a>
        <a class="row-link" href="code-of-conduct.html">${icon("heart")}<span><strong>Code of conduct</strong><span>What everyone taking part follows</span></span>${icon("chevronRight")}</a>
        <a class="row-link" href="security.html#reporting-a-vulnerability">${icon("shield")}<span><strong>Report a vulnerability</strong><span>Privately, not in a public issue</span></span>${icon("chevronRight")}</a>
        <a class="row-link" href="${REPO_URL}/releases" rel="noopener">${icon("clock")}<span><strong>Releases</strong><span>Your copy checks for a new one every Monday</span></span>${icon("chevronRight")}</a>
      </div>
    </div>
  </section>
</main>
${footer(version)}
${searchDialog()}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// The license page
// ---------------------------------------------------------------------------

function licenseBody(readme: string): string {
  const summary = sections(readme).get("License") ?? "";
  const text = readFileSync(join(ROOT, "LICENSE"), "utf8");
  return `<h2 id="license"><a class="anchor" href="#license" aria-label="Link to this section">#</a>In short</h2>
${renderMarkdown(summary, "README.md").html}
<h2 id="full-text"><a class="anchor" href="#full-text" aria-label="Link to this section">#</a>Full text</h2>
<pre class="license-text">${escapeHtml(text)}</pre>`;
}

// ---------------------------------------------------------------------------
// Search index
// ---------------------------------------------------------------------------

export interface Entry {
  /** page slug */ p: string;
  /** page title */ t: string;
  /** heading */ h: string;
  /** anchor */ a: string;
  /** text */ x: string;
}

/** One entry per ## or ### section of a rendered page. */
export function indexSections(slug: string, pageTitle: string, html: string): Entry[] {
  const entries: Entry[] = [];
  let last = { h: pageTitle, a: "", start: 0 };
  const push = (end: number) => {
    const x = stripTags(html.slice(last.start, end).replace(/<button[\s\S]*?<\/button>/g, "").replace(/<span class="code__lang">[\s\S]*?<\/span>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (x || last.a) entries.push({ p: slug, t: pageTitle, h: last.h, a: last.a, x });
  };
  for (const m of html.matchAll(/<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g)) {
    push(m.index!);
    const heading = stripTags(m[3].replace(/<a class="anchor"[\s\S]*?<\/a>/, "").replace(/<a class="chip[\s\S]*?<\/a>/, "")).trim();
    last = { h: heading, a: m[2], start: m.index! + m[0].length };
  }
  push(html.length);
  return entries;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function copy(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function notFound(version: string): string {
  // GitHub Pages serves this at any missing path, so links are made absolute when the address is known.
  return `${head({ title: "Not found · Athena", description: "This page isn't here.", path: "404.html" }, SITE_URL)}
<body class="page-home">
${AURORA}
<main id="content" class="not-found">
  <a class="brand" href="index.html">${BRAND_MARK}<span class="brand-name">Athena</span></a>
  <h1 class="hero__title">There's no page at this address. <span class="quiet">Search the docs, or start from home.</span></h1>
  <div class="hero__actions">
    <a class="btn btn--ink" href="index.html">${icon("home")}Home</a>
    <button class="btn btn--outline" type="button" data-search>${icon("search")}Search the docs</button>
  </div>
</main>
${footer(version)}
${searchDialog()}
</body>
</html>
`;
}

export function build() {
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const readmeSections = sections(readme);

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "assets"), { recursive: true });

  // The app's own design tokens and fonts.
  const tokens = readFileSync(join(ROOT, "app/src/styles/tokens.css"), "utf8").replace(/url\("\/fonts\//g, 'url("fonts/');
  writeFileSync(join(OUT, "assets/tokens.css"), tokens);
  for (const f of ["funnel-display-latin.woff2", "funnel-display-latin-ext.woff2", "geist-latin.woff2", "geist-latin-ext.woff2"]) {
    copy(join(ROOT, "app/public/fonts", f), join(OUT, "assets/fonts", f));
  }
  for (const f of ["favicon-32.png", "apple-touch-icon-180.png"]) {
    copy(join(ROOT, "app/public/icons", f), join(OUT, "assets/icons", f));
  }
  copy(join(SITE, "site.css"), join(OUT, "assets/site.css"));
  copy(join(SITE, "site.js"), join(OUT, "assets/site.js"));

  // Getting started first: other pages' links to README anchors need to know what it holds.
  const rendered = new Map<string, Rendered>();
  for (const doc of DOCS.filter((d) => d.sections)) {
    const md = doc.sections!.map((name) => `## ${name}\n\n${readmeSections.get(name) ?? ""}`).join("\n\n");
    const r = renderMarkdown(md, doc.file!);
    for (const h of r.headings) readmeAnchorsOnGettingStarted.add(h.id);
    rendered.set(doc.slug, r);
  }
  for (const doc of DOCS.filter((d) => !d.sections)) {
    if (doc.slug === "license") {
      const headings = [
        { depth: 2, id: "license", text: "In short" },
        { depth: 2, id: "full-text", text: "Full text" },
      ];
      rendered.set(doc.slug, { html: licenseBody(readme), headings });
    } else {
      const md = readFileSync(join(ROOT, doc.file!), "utf8");
      rendered.set(doc.slug, renderMarkdown(md, doc.file!, { changelog: doc.slug === "changelog" }));
    }
  }

  const blurbs = docBlurbs(readmeSections.get("Documentation") ?? "");
  const index: Entry[] = [];
  for (const doc of DOCS) {
    if (!doc.lede && doc.file && blurbs.has(doc.file)) doc.lede = blurbs.get(doc.file);
    const r = rendered.get(doc.slug)!;
    writeFileSync(join(OUT, `${doc.slug}.html`), docPage(doc, r.html, r.headings, version));
    if (doc.slug !== "license") index.push(...indexSections(doc.slug, doc.title, r.html));
  }

  writeFileSync(join(OUT, "index.html"), homePage(readme, version));
  writeFileSync(join(OUT, "search.json"), JSON.stringify(index));
  writeFileSync(join(OUT, "404.html"), notFound(version));
  writeFileSync(join(OUT, ".nojekyll"), "");

  for (const [abs, out] of copiedMedia) copy(abs, join(OUT, out));

  console.log(`Built ${DOCS.length + 2} pages and ${index.length} search entries into ${relative(ROOT, OUT)}/`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) build();

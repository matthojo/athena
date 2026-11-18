/**
 * Reading what a connected account's tool sends back, for link previews
 * (lib/link-previews.ts PreviewSource). Pure: the server opens the account
 * and calls the tool (netlify/lib/rich-links/connector-previews.ts).
 *
 * Notion: its MCP server's `notion-fetch` takes a page's address and answers
 * with JSON ({ title, text, metadata }) or with the page as Markdown-like
 * text. Only the title and the opening lines are kept; nothing is run.
 */

/** notion.so, www.notion.so and a workspace's *.notion.site pages. */
export function isNotionUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "notion.so" || host === "www.notion.so" || /^[a-z0-9-]+\.notion\.site$/.test(host);
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Tags and Markdown marks out, lines kept: what a card can show as plain text. */
function plainLines(text: string): string[] {
  return text
    .replace(/<[^>]{0,500}>/g, "\n")
    .split(/\r?\n/)
    .map((l) => squash(l.replace(/^#{1,6}\s+/, "").replace(/^[-*>•]\s+/, "").replace(/[*_`~]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")))
    .filter(Boolean);
}

/** A preview from notion-fetch's answer, or null when it isn't a page Athena can show. */
export function notionPreview(answer: string): { title: string; summary: string | null; site_name: string; author: null } | null {
  let title: string | null = null;
  let body = answer;
  try {
    const j = JSON.parse(answer) as { title?: unknown; text?: unknown; content?: unknown };
    if (j && typeof j === "object") {
      if (typeof j.title === "string") title = squash(j.title);
      body = typeof j.text === "string" ? j.text : typeof j.content === "string" ? j.content : "";
    }
  } catch {
    // not JSON: Markdown-like text
  }
  const lines = plainLines(body);
  if (!title) {
    const attr = /\btitle="([^"]{1,300})"/.exec(body)?.[1] ?? /^title:\s*(.{1,300})$/im.exec(body)?.[1];
    const heading = /^#\s+(.{1,300})$/m.exec(body)?.[1];
    title = attr ? squash(attr) : heading ? squash(heading) : null;
  }
  if (!title) return null;
  const rest = lines.filter((l) => l !== title && !/^(title|url|id|type):/i.test(l));
  const all = rest.join(" ").trim();
  const summary = all.length > 300 ? `${all.slice(0, 299).trimEnd()}…` : all;
  return { title: title.slice(0, 300), summary: summary || null, site_name: "Notion", author: null };
}

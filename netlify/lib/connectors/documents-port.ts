/**
 * lib/documents.ts's ports to the providers: Google Docs (google-docs.ts,
 * drive.file and the request gate there) and Notion (callNotionWrite in
 * mcp-client.ts, create-only). Tests pass their own ports instead.
 */
import type { DocumentPorts } from "../../../lib/documents";
import { notionCreated, notionId, notionLink, NOTION_CREATE_TOOL, NOTION_MOVE_TOOL, NOTION_UPDATE_TOOL, REMOVED_PAGE_TITLE } from "../../../lib/documents-rules";
import { AthenaInputError } from "../../../lib/db";
import { callNotionWrite, callTool, openConnector } from "./mcp-client";
import { createDoc, openDocsAccount, replaceDoc, trashDoc } from "./google-docs";

type Open = Awaited<ReturnType<typeof openConnector>>;
type Opener = (connectorId: string) => Promise<Open>;

async function withNotion<T>(opener: Opener, connectorId: string, fn: (open: Open) => Promise<T>): Promise<T> {
  const open = await opener(connectorId);
  try {
    if (open.connector.provider !== "notion") throw new AthenaInputError("That isn't a Notion account");
    return await fn(open);
  } finally {
    await open.close();
  }
}

const failed = (what: string, text: string) => new AthenaInputError(`Notion couldn't ${what}: ${text.slice(0, 200)}`);

/** Pages in a notion-search reply: JSON where it is, links with titles otherwise. */
export function parseNotionSearch(text: string): Array<{ id: string; title: string; url: string }> {
  const out = new Map<string, { id: string; title: string; url: string }>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const id = notionId(o.id) ?? notionId(o.url);
      const type = typeof o.type === "string" ? o.type : "page";
      if (id && typeof o.title === "string" && type === "page") out.set(id, { id, title: o.title.trim() || "Untitled", url: notionLink(o.url, id) });
      Object.values(o).forEach(visit);
    }
  };
  try {
    visit(JSON.parse(text));
  } catch {
    for (const m of text.matchAll(/(?:^|\n)\s*(?:[-*]\s*)?(?:Title:\s*)?([^\n]{1,120}?)\s*[\n(—-]+\s*(https:\/\/(?:www\.)?notion\.so\/[^\s)]+)/g)) {
      const id = notionId(m[2]);
      if (id) out.set(id, { id, title: m[1].replace(/^["']|["']$/g, "").trim() || "Untitled", url: notionLink(m[2], id) });
    }
  }
  return [...out.values()].slice(0, 20);
}

/** The ports, with how accounts are opened: the real openers by default; a test passes a fake fetch for Google and a fake MCP client for Notion. */
export function makeDocumentPorts(deps: { openNotion?: Opener; fetch?: typeof fetch } = {}): DocumentPorts {
  const opener = deps.openNotion ?? openConnector;
  const docs = (id: string) => openDocsAccount(id, deps.fetch ?? ((...a) => fetch(...a)));
  return {
    google: {
      create: async (connectorId, input) => createDoc(await docs(connectorId), input),
      replace: async (connectorId, input) => replaceDoc(await docs(connectorId), input),
      trash: async (connectorId, input) => trashDoc(await docs(connectorId), input),
    },
    notion: {
      create: (connectorId, input) =>
        withNotion(opener, connectorId, async (open) => {
          const r = await callNotionWrite(
            open,
            NOTION_CREATE_TOOL,
            { parent: { page_id: input.parentId }, pages: [{ properties: { title: input.title.slice(0, 200) }, content: input.markdown }] },
            { parentId: input.parentId, own: new Set() },
          );
          if (r.isError) throw failed("make the page", r.text);
          const made = notionCreated(r.text);
          if (!made) throw failed("say which page it made", r.text);
          return { id: made.id, url: notionLink(made.url, made.id) };
        }),
      remove: (connectorId, input) =>
        withNotion(opener, connectorId, async (open) => {
          const own = new Set(input.own);
          let removedId = input.removedId;
          let made = false;
          if (!removedId) {
            // First Undo for this account: Athena's own page, under the parent the owner chose.
            const r = await callNotionWrite(open, NOTION_CREATE_TOOL, { parent: { page_id: input.parentId }, pages: [{ properties: { title: REMOVED_PAGE_TITLE }, content: "Pages you undid in Athena. Delete them here when you're sure." }] }, { parentId: input.parentId, own });
            if (r.isError) throw failed("make the Removed by Athena page", r.text);
            const page = notionCreated(r.text);
            if (!page) throw failed("say which page it made", r.text);
            removedId = page.id;
            made = true;
            own.add(removedId);
          }
          const moved = await callNotionWrite(open, NOTION_MOVE_TOOL, { page_or_database_ids: [input.id], new_parent: { page_id: removedId } }, { parentId: input.parentId, own, removedId });
          if (moved.isError) throw failed("move the page", moved.text);
          return { removedId, made };
        }),
      rewrite: (connectorId, input) =>
        withNotion(opener, connectorId, async (open) => {
          const rules = { parentId: input.parentId, own: input.own };
          const title = await callNotionWrite(open, NOTION_UPDATE_TOOL, { data: { page_id: input.id, command: "update_properties", properties: { title: input.title.slice(0, 200) } } }, rules);
          if (title.isError) throw failed("rename the page", title.text);
          const body = await callNotionWrite(open, NOTION_UPDATE_TOOL, { data: { page_id: input.id, command: "replace_content", new_str: input.markdown } }, rules);
          if (body.isError) throw failed("update the page", body.text);
        }),
      search: (connectorId, query) =>
        withNotion(opener, connectorId, async (open) => {
          // An ordinary read, under the account's own allowlist.
          if (!open.connector.allowed_tools.includes("notion-search")) throw new AthenaInputError("Allow notion-search for this account to pick a page");
          const r = await callTool(open, "notion-search", { query: query.slice(0, 100) || "page" });
          if (r.isError) throw failed("search", r.text);
          return parseNotionSearch(r.text);
        }),
    },
  };
}

export const documentPorts: DocumentPorts = makeDocumentPorts();

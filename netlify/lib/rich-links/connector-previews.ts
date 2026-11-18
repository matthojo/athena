/**
 * Link previews through the owner's connected accounts (lib/link-previews.ts
 * PreviewSource). Registered once, when the rich links routes load.
 *
 *  - Notion: when a Notion account is connected and allows `notion-fetch`,
 *    a notion.so or *.notion.site address is read through it, so a private
 *    page gets its real title and opening lines instead of a sign-in page.
 *    Read-only: notion-fetch is one of the preset's read tools. Whatever it
 *    sends is sealed with the rest of the preview.
 *
 * No account, a signed-out one, or an error: null, and the page is read like
 * any other.
 */
import { listConnectors } from "../../../lib/connectors";
import { registerPreviewSource } from "../../../lib/link-previews";
import { isNotionUrl, notionPreview } from "../../../lib/link-preview-sources";
import { callTool, openConnector } from "../connectors/mcp-client";

const TIMEOUT_MS = 8_000;

/** Replaceable in tests. */
export const connectorPreviewDeps = { listConnectors, openConnector, callTool };

function within<T>(ms: number, run: Promise<T>): Promise<T> {
  return Promise.race([run, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms).unref?.())]);
}

export async function readNotionPage(url: string): Promise<ReturnType<typeof notionPreview>> {
  const accounts = await connectorPreviewDeps.listConnectors();
  const notion = accounts.find((c) => c.provider === "notion" && c.status === "connected" && c.allowed_tools.includes("notion-fetch"));
  if (!notion) return null;
  const open = await connectorPreviewDeps.openConnector(notion.id);
  try {
    const r = await within(TIMEOUT_MS, connectorPreviewDeps.callTool(open, "notion-fetch", { id: url }));
    return r.isError ? null : notionPreview(r.text);
  } finally {
    await open.close().catch(() => undefined);
  }
}

registerPreviewSource({ id: "notion", matches: isNotionUrl, read: readNotionPage });

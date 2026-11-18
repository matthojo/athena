/**
 * To-do contexts over REST (lib/todo-contexts.ts), mounted by
 * netlify/functions/api.ts behind the same bearer token:
 *
 *   GET   /api/todo-contexts            { contexts, counts }: archived ones too, and open to-dos per live context
 *   POST  /api/todo-contexts            { kind, name, icon?, colour? } → context
 *   PATCH /api/todo-contexts/:id        { name?, icon?, colour?, archived? } → context (archived: remove, or Undo)
 *   POST  /api/todo-contexts/order      { kind, ids } → { contexts }
 *
 * A to-do's own context is set on the commitment: PATCH /api/commitments/:id { area_id, where_id }.
 */
import { AthenaInputError } from "../../lib/db";
import { contextCounts, createContext, listContexts, reorderContexts, updateContext, type ContextInput } from "../../lib/todo-contexts";
import type { ContextKind } from "../../lib/todo-context";

type Reply = (data: unknown, status?: number) => Response;

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const data = await req.json();
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AthenaInputError("Send a JSON object");
}

const str = (b: Record<string, unknown>, k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);

function input(b: Record<string, unknown>): ContextInput {
  return {
    kind: str(b, "kind") as ContextKind | undefined,
    name: str(b, "name"),
    icon: str(b, "icon"),
    colour: str(b, "colour"),
    archived: typeof b.archived === "boolean" ? b.archived : undefined,
  };
}

/** /api/todo-contexts*; null for anything else. */
export async function handleTodoContextRoutes(req: Request, segments: string[], reply: Reply): Promise<Response | null> {
  const [, first, second] = segments;
  if (first !== "todo-contexts" || segments.length > 3) return null;
  if (segments.length === 2) {
    if (req.method === "GET") {
      const [contexts, counts] = await Promise.all([listContexts({ includeArchived: true }), contextCounts()]);
      return reply({ contexts, counts });
    }
    if (req.method === "POST") return reply(await createContext(input(await body(req))), 201);
    return reply({ error: "Method not allowed" }, 405);
  }
  if (second === "order") {
    if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
    const b = await body(req);
    return reply({ contexts: await reorderContexts(str(b, "kind") as ContextKind, b.ids as string[]) });
  }
  if (req.method !== "PATCH") return reply({ error: "Method not allowed" }, 405);
  return reply(await updateContext(second, input(await body(req))));
}

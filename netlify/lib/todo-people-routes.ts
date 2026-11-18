/**
 * The person an unlinked to-do names, over REST (lib/todo-people.ts), mounted by
 * netlify/functions/api.ts behind the full gate (the app's token or a full key;
 * a capture key gets 401 before this is reached):
 *
 *   GET  /api/todo-people               { suggestions: { <to-do id>: [{ id, name }] } }
 *   POST /api/todo-people/:id/dismiss   { dismissed: true }; that to-do isn't offered anyone again
 *
 * Linking is the to-do's own PATCH /api/commitments/:id { person_id }.
 */
import { dismissTodoPerson, todoPersonSuggestions } from "../../lib/todo-people";

type Reply = (data: unknown, status?: number) => Response;

/** /api/todo-people*; null for anything else. */
export async function handleTodoPeopleRoutes(req: Request, segments: string[], reply: Reply): Promise<Response | null> {
  const [, first, second, third] = segments;
  if (first !== "todo-people") return null;
  if (segments.length === 2) {
    if (req.method !== "GET") return reply({ error: "Method not allowed" }, 405);
    return reply({ suggestions: await todoPersonSuggestions() });
  }
  if (segments.length !== 4 || third !== "dismiss") return null;
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  await dismissTodoPerson(second);
  return reply({ dismissed: true });
}

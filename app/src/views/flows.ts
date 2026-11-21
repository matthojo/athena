/**
 * Flows (lib/flow-types.ts): a trigger, then steps with branches, beside
 * Team. #/flows, #/flows/new, #/flows/<id> and #/flows/runs/<id> all land
 * here, with `param` null, "new", a flow's id, or "runs/<id>".
 *
 *   #/flows             the list, with Athena's suggestions (flows/list.ts)
 *   #/flows/new         the list, with the New flow sheet over it
 *   #/flows/<id>        one flow's editor (flows/editor.ts)
 *   #/flows/runs/<id>   one run, step by step (flows/run-page.ts)
 *
 * Like Team, it needs the server: nothing is kept offline.
 */
import "../styles/flows.css";
import type { ViewId } from "../components/nav";
import { renderFlowList } from "../flows/list";
import { renderFlowEditor, setDraftNotes } from "../flows/editor";
import { renderRunPage } from "../flows/run-page";
import { openNewFlow } from "../flows/new-sheet";

type Go = (view: ViewId, opts?: { noteId?: string | null }) => void;

export interface FlowsViewContext {
  go: Go;
  /** null: the list; "new": the list with New flow open; "runs/<id>": a run; otherwise a flow's id. */
  param: string | null;
}

/** Pages this visit pushed, so Back steps through them instead of leaving the app. */
let pushed = 0;

function push(go: Go, param: string | null) {
  pushed++;
  history.pushState(history.state, "", `#/flows${param ? `/${param.split("/").map(encodeURIComponent).join("/")}` : ""}`);
  go("flows", { noteId: param });
}

function back(go: Go, fallback: string | null) {
  if (pushed > 0 && history.length > 1) {
    pushed--;
    history.back();
  } else go("flows", { noteId: fallback });
}

export function renderFlows(ctx: FlowsViewContext): { el: HTMLElement; destroy: () => void } {
  const { go, param } = ctx;
  const openFlow = (id: string) => push(go, id);
  const openRun = (id: string) => push(go, `runs/${id}`);

  if (param?.startsWith("runs/")) {
    return renderRunPage({ runId: param.slice("runs/".length), openRun, toFlow: (id) => back(go, id) });
  }
  if (param && param !== "new") {
    return renderFlowEditor({ id: param, back: () => back(go, null), openRun });
  }

  const openNew = (text?: string) =>
    openNewFlow({
      text,
      onMade: (f, notes) => {
        setDraftNotes(f.id, notes);
        // From #/flows/new the editor takes its place; from the list it's a new page.
        if (param === "new") {
          history.replaceState(history.state, "", `#/flows/${encodeURIComponent(f.id)}`);
          go("flows", { noteId: f.id });
        } else openFlow(f.id);
      },
    });
  const view = renderFlowList({ open: openFlow, openNew });
  if (param === "new") {
    history.replaceState(history.state, "", "#/flows");
    queueMicrotask(() => openNew());
  }
  return view;
}

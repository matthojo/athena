/**
 * The context menu for a link in a note (right-click, long-press, Shift+F10),
 * with the actions the owner approved:
 *
 *   1. Open (⌘↵), the kind's own action, Copy link (⌘C)
 *   2. Show as: Mention, Link, Card, plus Embed only where there's a player
 *   3. Remove (⌫, in red)
 *
 * The kind's own action: to-do Mark done / Mark not done; person Log a
 * catch-up; Watch & read Mark as finished; Saved Move to… (a submenu);
 * event Add a reminder; a web page has none yet (Open opens a new tab).
 * The peek card is the menu's preview. A read-only note has no Show as or
 * Remove. Move to… and Add a reminder appear only when the data source can
 * do them (link-data.ts).
 */

import type { ContextMenuSpec, MenuAction } from "../components/context-menu";
import { showToast } from "../components/toast";
import { athenaUrl } from "../../../lib/links";
import { linkData } from "./link-data";
import { MODE_ICON, MODE_LABEL, allowedModes, type LinkMode } from "./link-model";
import { peekContent } from "./link-peek";
import type { Thing } from "./link-render";

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Shortcut hints; a focused link in the editor answers to them. */
export const KEYS = { open: mac ? "⌘↵" : "Ctrl+Enter", copy: mac ? "⌘C" : "Ctrl+C", remove: "⌫" };

export interface LinkMenuHandlers {
  open(): void;
  /** Absent in a read-only note. */
  show?(mode: LinkMode): void;
  remove?(): void;
}

export const linkUrl = (t: Thing): string => (t.target.target === "web" ? t.target.url : athenaUrl(t.target.kind, t.target.id));

export function copyLink(t: Thing): void {
  const done = () => showToast("Link copied", { icon: "link" });
  const fail = () => showToast("Couldn't copy the link", { icon: "close" });
  try {
    navigator.clipboard?.writeText(linkUrl(t)).then(done, fail) ?? fail();
  } catch {
    fail();
  }
}

export function openInBrowser(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

const failed = () => showToast("Couldn't do that. Are you online?", { icon: "wifiOff" });
/** The toast's Undo, as the to-do's has, when the action can be undone. */
const undoAction = (undo?: () => Promise<void>) => (undo ? { action: { label: "Undo", run: () => void undo().catch(failed) } } : {});

function kindActions(t: Thing, offline: boolean): MenuAction[] {
  const data = linkData();
  const live = t.live;
  // A web page has no action of its own until the reader view exists; Open
  // opens a new tab (owner's answers, 2026-11-08).
  if (t.target.target === "web") return [];
  const id = t.target.id;
  switch (t.target.kind) {
    case "todo": {
      const done = live?.kind === "todo" && live.done;
      return [
        {
          id: "done",
          label: done ? "Mark not done" : "Mark done",
          icon: "check",
          run: () =>
            void data.toggleTodo(id).then(
              (now) => showToast(now ? "Marked done" : "Marked not done", { icon: "check", action: { label: "Undo", run: () => void data.toggleTodo(id) } }),
              failed
            ),
        },
      ];
    }
    case "person":
      return [
        {
          id: "catch-up",
          label: "Log a catch-up",
          icon: "chat",
          run: () => void data.logCatchUp(id).then(({ undo }) => showToast(`Catch-up with ${t.title.split(" ")[0]} logged for today`, { icon: "check", ...undoAction(undo) }), failed),
        },
      ];
    case "watch":
      return [{ id: "finished", label: "Mark as finished", icon: "flag", run: () => void data.markWatched(id).then(({ undo }) => showToast(`${t.title} marked as finished`, { icon: "check", ...undoAction(undo) }), failed) }];
    case "saved": {
      const cols = data.savedCollections?.(id);
      if (!cols?.length || !data.moveSaved) return [];
      return [
        {
          id: "move",
          label: "Move to…",
          icon: "folder",
          submenu: [
            cols.map((c) =>
              c.current
                ? { id: `move-${c.id}`, label: c.name, icon: "check" as const, disabled: true, hint: "It's here now" }
                : { id: `move-${c.id}`, label: c.name, icon: "folder" as const, run: () => void data.moveSaved!(id, c.id).then((said) => showToast(said || `Moved to ${c.name}`, { icon: "folder" }), failed) }
            ),
          ],
        },
      ];
    }
    case "place": {
      const map = live?.kind === "place" ? live.openMap : null;
      return map ? [{ id: "map", label: "Open map", icon: "pin", run: () => openInBrowser(map) }] : [];
    }
    case "event":
      if (!data.remindEvent) return [];
      return [{ id: "remind", label: "Add a reminder", icon: "bell", run: () => void data.remindEvent!(id).then(() => showToast("Reminder set for the day before", { icon: "bell" }), failed) }];
    default:
      return [];
  }
}

/** The whole menu for one link shown in `mode`. */
export function linkMenu(t: Thing, mode: LinkMode, on: LinkMenuHandlers, o: { offline?: boolean } = {}): ContextMenuSpec {
  const groups: ContextMenuSpec["groups"] = [
    [
      { id: "open", label: "Open", icon: "arrowRight", shortcut: KEYS.open, run: () => on.open() },
      ...kindActions(t, !!o.offline),
      { id: "copy", label: "Copy link", icon: "copy", shortcut: KEYS.copy, run: () => copyLink(t) },
    ],
  ];
  if (on.show) {
    const show = on.show;
    groups.push([
      {
        kind: "choice",
        id: "mode",
        label: "Show as",
        value: mode,
        options: allowedModes(t.target).map((m) => ({ value: m, label: MODE_LABEL[m], icon: MODE_ICON[m] })),
        choose: (m) => show(m as LinkMode),
      },
    ]);
  }
  if (on.remove) groups.push([{ id: "remove", label: "Remove", icon: "trash", shortcut: KEYS.remove, destructive: true, run: () => on.remove!() }]);
  return { label: t.title, preview: peekContent(t), groups };
}

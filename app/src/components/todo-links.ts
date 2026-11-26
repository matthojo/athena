/**
 * A to-do's links: the pages and the things in Athena it needs to get done.
 *
 * One box adds both. Paste or type an address and it's a web link, named by
 * the page's own title once its preview arrives (db/rich-links.ts, the same
 * preview a note's pasted link gets). Type words and it searches Athena, as
 * @ does in a note: people, places, notes, events, saved items, other to-dos.
 * Each link opens where it points (a web page in a new tab, an Athena item in
 * its page or sheet) and can be renamed or removed.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { mentionIcon } from "./mention-menu";
import { MENTION_KIND_LABEL, type MentionResult } from "../../../lib/mentions";
import { athenaUrl, type LinkKind } from "../../../lib/links";
import { cleanLinkUrl, linkSite, linkTarget, LINK_TITLE_LENGTH, MAX_LINKS, newItemId, type TodoLink } from "../../../lib/todo-details";
import { hueFor } from "../lib/format";
import { showToast } from "./toast";

export interface LinksEditor {
  el: HTMLElement;
  set: (links: TodoLink[]) => void;
  links: () => TodoLink[];
  focusAdd: () => void;
}

type Suggestion = { kind: "web"; url: string } | { kind: "athena"; row: MentionResult };

const KIND_LABEL = MENTION_KIND_LABEL as Record<string, string>;

export function linksEditor(opts: {
  links: TodoLink[];
  onChange: (links: TodoLink[]) => void;
  onOpen: (link: TodoLink) => void;
  /** The to-do's own id, so it isn't offered as a link to itself. */
  selfId?: () => string | null;
  readOnly?: boolean;
}): LinksEditor {
  let links: TodoLink[] = opts.links.map((l) => ({ ...l }));
  const list = h("ul", { class: "tlinks", "aria-label": "Links" });
  const count = h("span", { class: "tsec__count" });

  const input = h("input", {
    class: "tlinks__input",
    type: "text",
    inputmode: "url",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "Paste a link, or search Athena",
    "aria-label": "Add a link: paste an address or search Athena",
    role: "combobox",
    "aria-expanded": "false",
    "aria-autocomplete": "list",
  }) as HTMLInputElement;
  const results = h("div", { class: "tlinks__results", role: "listbox", "aria-label": "Links to add", hidden: true });
  const addRow = h("div", { class: "tlinks__add" }, h("span", { class: "tsteps__add-mark", "aria-hidden": "true" }, icons.plus()), input);
  const el = h(
    "section",
    { class: "tsec tsec--links", "aria-label": "Links" },
    h("h3", { class: "tsec__head" }, icons.link(), h("span", { class: "tsec__label" }, "Links"), count),
    list,
    opts.readOnly ? null : h("div", { class: "tlinks__adder" }, addRow, results)
  );

  const commit = () => {
    paintCount();
    opts.onChange(links.map((l) => ({ ...l })));
  };
  const paintCount = () => {
    count.textContent = links.length ? String(links.length) : "";
    addRow.hidden = links.length >= MAX_LINKS;
  };

  // ---------- rows ----------

  function tile(link: TodoLink): HTMLElement {
    const target = linkTarget(link);
    if (target) return h("span", { class: "tlink__tile", "data-kind": target.kind, "aria-hidden": "true" }, icons[mentionIcon(target.kind)]());
    const site = linkSite(link.url);
    const t = h("span", { class: "tlink__tile tlink__tile--web", style: `--hue:${hueFor(site)}`, "aria-hidden": "true" }, site.slice(0, 1).toUpperCase());
    // A link a model or an agent added is held: its page isn't fetched (lib/todo-details.ts TodoLink.held).
    if (link.held) return t;
    // The page's own icon, when its preview has one.
    void import("../db/rich-links").then(({ loadPreview }) =>
      loadPreview(link.url).then((p) => {
        if (!p?.favicon_url) return;
        const img = h("img", { src: p.favicon_url, alt: "", width: 18, height: 18, decoding: "async" }) as HTMLImageElement;
        img.addEventListener("load", () => t.replaceChildren(img), { once: true });
      }).catch(() => undefined)
    );
    return t;
  }

  function row(link: TodoLink): HTMLElement {
    const target = linkTarget(link);
    const sub = target ? KIND_LABEL[target.kind] ?? "In Athena" : linkSite(link.url);
    const open = h(
      "a",
      target ? { class: "tlink__open", href: link.url, "data-kind": target.kind } : { class: "tlink__open", href: link.url, target: "_blank", rel: "noopener noreferrer" },
      tile(link),
      h("span", { class: "tlink__words" }, h("span", { class: "tlink__title" }, link.title), h("span", { class: "tlink__sub" }, sub)),
      target ? icons.chevronRight() : icons.external()
    );
    open.addEventListener("click", (e) => {
      if (!target) return; // the browser opens it in a new tab
      e.preventDefault();
      opts.onOpen(link);
    });
    const rename = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost tlink__act", type: "button", "aria-label": `Rename “${link.title}”` }, icons.pen());
    const remove = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost tlink__act", type: "button", "aria-label": `Remove “${link.title}”` }, icons.close());
    const li = h("li", { class: "tlink", "data-id": link.id }, open, opts.readOnly ? null : h("span", { class: "tlink__acts" }, rename, remove));
    remove.addEventListener("click", () => {
      const at = links.findIndex((l) => l.id === link.id);
      const removed = links[at] ? { ...links[at] } : { ...link };
      links = links.filter((l) => l.id !== link.id);
      li.remove();
      commit();
      input.focus();
      showToast(`Removed “${removed.title}”`, {
        icon: "trash",
        action: {
          label: "Undo",
          run: () => {
            if (links.some((l) => l.url === removed.url) || links.length >= MAX_LINKS) return;
            links.splice(Math.max(0, Math.min(at, links.length)), 0, removed);
            paint();
            commit();
          },
        },
      });
    });
    rename.addEventListener("click", () => startRename(li, link));
    return li;
  }

  /** The title becomes a box; Enter or leaving keeps it, Escape puts it back. */
  function startRename(li: HTMLElement, link: TodoLink) {
    const box = h("input", { class: "tlink__rename", type: "text", maxlength: LINK_TITLE_LENGTH, "aria-label": "Link name", value: link.title }) as HTMLInputElement;
    box.value = link.title;
    const shown = li.querySelector(".tlink__open")!;
    shown.replaceWith(box);
    box.focus();
    box.select();
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const v = box.value.replace(/\s+/g, " ").trim();
      const l = links.find((x) => x.id === link.id);
      if (keep && l && v && v !== l.title) {
        l.title = v;
        commit();
      }
      li.replaceWith(row(l ?? link));
    };
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    box.addEventListener("blur", () => finish(true));
  }

  // ---------- adding ----------

  let suggestions: Suggestion[] = [];
  let active = 0;
  let searchSeq = 0;

  function showResults() {
    const has = suggestions.length > 0;
    results.hidden = !has;
    input.setAttribute("aria-expanded", String(has));
    results.replaceChildren(
      ...suggestions.map((s, i) => {
        const b = h("button", { class: "tlinks__result", type: "button", role: "option", tabindex: -1, "aria-selected": String(i === active), id: `tl-opt-${i}` });
        if (s.kind === "web") {
          b.append(h("span", { class: "tlink__tile tlink__tile--web", style: `--hue:${hueFor(linkSite(s.url))}`, "aria-hidden": "true" }, icons.globe()), h("span", { class: "tlink__words" }, h("span", { class: "tlink__title" }, "Add this link"), h("span", { class: "tlink__sub" }, linkSite(s.url))), h("kbd", { class: "tlinks__kbd" }, "↵"));
        } else {
          b.append(
            h("span", { class: "tlink__tile", "data-kind": s.row.kind, "aria-hidden": "true" }, icons[mentionIcon(s.row.kind, s.row.kind_id)]()),
            h("span", { class: "tlink__words" }, h("span", { class: "tlink__title" }, s.row.title), h("span", { class: "tlink__sub" }, [KIND_LABEL[s.row.kind], s.row.subtitle].filter(Boolean).join(" · ")))
          );
        }
        b.addEventListener("pointerdown", (e) => e.preventDefault());
        b.addEventListener("click", () => pick(s));
        return b;
      })
    );
    if (has) {
      input.setAttribute("aria-activedescendant", `tl-opt-${active}`);
      // Keep the list clear of the sheet's footer.
      requestAnimationFrame(() => results.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    }
    else input.removeAttribute("aria-activedescendant");
  }

  async function search() {
    const q = input.value.trim();
    const seq = ++searchSeq;
    active = 0;
    if (!q) {
      suggestions = [];
      return showResults();
    }
    const url = /\s/.test(q) ? null : cleanLinkUrl(q);
    if (url && !linkTarget({ url })) {
      suggestions = [{ kind: "web", url }];
      return showResults();
    }
    const { findMentions } = await import("../db/mentions");
    const rows = await findMentions(q).catch(() => [] as MentionResult[]);
    if (seq !== searchSeq) return;
    const have = new Set(links.map((l) => l.url));
    const self = opts.selfId?.();
    suggestions = rows
      .filter((r) => !have.has(athenaUrl(r.kind as LinkKind, r.id)) && !(r.kind === "todo" && r.id === self))
      .slice(0, 6)
      .map((row) => ({ kind: "athena", row }));
    showResults();
  }

  function pick(s: Suggestion) {
    if (links.length >= MAX_LINKS) return;
    const link: TodoLink =
      s.kind === "web"
        ? { id: newItemId(), url: s.url, title: linkSite(s.url) }
        : { id: newItemId(), url: athenaUrl(s.row.kind as LinkKind, s.row.id), title: s.row.title.slice(0, LINK_TITLE_LENGTH) };
    if (links.some((l) => l.url === link.url)) {
      clear();
      return;
    }
    links.push(link);
    const li = row(link);
    li.classList.add("is-new");
    list.append(li);
    commit();
    clear();
    if (s.kind === "web") nameFromPage(link);
  }

  /** A web link starts as its site; once the page's title is known, that's its name (unless renamed meanwhile). */
  function nameFromPage(link: TodoLink) {
    void import("../db/rich-links").then(({ loadPreview }) =>
      loadPreview(link.url).then((p) => {
        const title = p?.status === "ok" ? p.title?.replace(/\s+/g, " ").trim() : null;
        const l = links.find((x) => x.id === link.id);
        if (!title || !l || l.title !== linkSite(link.url)) return;
        l.title = title.slice(0, LINK_TITLE_LENGTH);
        list.querySelector(`.tlink[data-id="${CSS.escape(l.id)}"]`)?.replaceWith(row(l));
        commit();
      }).catch(() => undefined)
    );
  }

  function clear() {
    input.value = "";
    suggestions = [];
    showResults();
  }

  let timer: number | undefined;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void search(), 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!suggestions.length) return;
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length;
      showResults();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const q = input.value.trim();
      if (suggestions[active]) pick(suggestions[active]);
      else if (q) {
        const url = cleanLinkUrl(q);
        if (url) pick({ kind: "web", url });
      }
    } else if (e.key === "Escape" && (input.value || suggestions.length)) {
      e.preventDefault();
      e.stopPropagation();
      clear();
    }
  });
  // A pasted address goes straight in.
  input.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text/plain")?.trim() ?? "";
    const url = text && !/\s/.test(text) ? cleanLinkUrl(text) : null;
    if (!url || input.value.trim()) return;
    e.preventDefault();
    const target = linkTarget({ url });
    if (!target) return pick({ kind: "web", url });
    void import("../db/mentions").then(({ mentionById }) =>
      mentionById(target.kind, target.id).then((row) => row && pick({ kind: "athena", row }))
    );
  });
  input.addEventListener("blur", () => setTimeout(() => {
    if (document.activeElement !== input) {
      suggestions = [];
      showResults();
    }
  }, 120));

  function paint() {
    list.replaceChildren(...links.map(row));
    paintCount();
  }
  paint();

  return {
    el,
    set(next) {
      if (el.contains(document.activeElement)) return;
      links = next.map((l) => ({ ...l }));
      paint();
    },
    links: () => links.map((l) => ({ ...l })),
    focusAdd: () => input.focus(),
  };
}

/**
 * "Let Athena create pages" on a Notion account (lib/documents.ts): off
 * until the owner picks a parent page. On, "Send to Notion" makes a new page
 * under it. Athena changes only pages it made, and never edits, moves or
 * deletes the owner's own (documents-rules.ts notionWriteProblem).
 */
import "../styles/documents.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { brandLogo } from "./brand-logo";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { loadNotionWrite, saveNotionParent, searchNotionPages, type NotionWrite } from "../db/documents";

type Group = (title: string, ...children: Array<HTMLElement | null>) => HTMLElement;

/** Pick the page new ones go under. Resolves null when the sheet is closed. */
export function pickNotionParent(connectorId: string): Promise<{ id: string; title: string } | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { id: string; title: string } | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const search = h("input", { class: "tpl-input", type: "search", placeholder: "Search your Notion pages", "aria-label": "Search your Notion pages", autocomplete: "off" }) as HTMLInputElement;
    const list = h("ul", { class: "tpl__choices", role: "list", "aria-live": "polite" });
    const body = h(
      "div",
      { class: "nw__picker" },
      h("p", { class: "tpl__lede" }, "New pages go inside the one you pick. Athena can only see pages you've shared with it in Notion."),
      search,
      list
    );
    const sheet = openSheet({ label: "Pick a parent page", title: "Where should pages go?", body, onClose: () => finish(null) });
    (sheet.dialog.querySelector(".sheet__scroll") as HTMLElement).replaceChildren(body);
    let seq = 0;
    const paint = async () => {
      const mine = ++seq;
      list.replaceChildren(h("li", { class: "tpl__loading" }, h("span", { class: "doc-spin", "aria-hidden": "true" })));
      try {
        const pages = await searchNotionPages(connectorId, search.value);
        if (mine !== seq) return;
        list.replaceChildren(
          ...(pages.length
            ? pages.map((p) => {
                const b = h("button", { class: "tpl-choice", type: "button" }, brandLogo("notion", "sm"), h("span", { class: "tpl-choice__text" }, h("span", { class: "tpl-choice__title" }, p.title)));
                b.addEventListener("click", () => {
                  finish({ id: p.id, title: p.title });
                  sheet.close();
                });
                return h("li", {}, b);
              })
            : [h("li", { class: "tpl__empty" }, search.value ? "No pages by that name." : "No pages shared with Athena yet.")])
        );
      } catch (error) {
        if (mine === seq) list.replaceChildren(h("li", { class: "tpl__empty" }, error instanceof Error ? error.message : "Couldn't search Notion"));
      }
    };
    let t: ReturnType<typeof setTimeout>;
    search.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => void paint(), 250);
    });
    void paint();
  });
}

/** The account page's group. */
export function notionWriteGroup(connectorId: string, group: Group): HTMLElement {
  const wrap = h("div", {});
  const sw = h("input", { type: "checkbox", role: "switch", class: "switch", "aria-label": "Let Athena create pages" }) as HTMLInputElement;
  const parentRow = h("div", { class: "nw__parent", hidden: true });
  const hint = h("p", { class: "form__hint" });
  let state: NotionWrite = { enabled: false, parent: null };

  const paint = () => {
    sw.checked = state.enabled;
    parentRow.hidden = !state.parent;
    if (state.parent) {
      const change = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, "Change");
      change.addEventListener("click", () => void choose());
      parentRow.replaceChildren(brandLogo("notion", "sm"), h("span", { class: "nw__parent-title" }, state.parent.title, h("small", {}, "New pages go here")), change);
    }
    hint.textContent = state.enabled
      ? "Athena only makes new pages under this one, and changes only pages it made. It never edits, moves or deletes your own pages."
      : "Notion will say Athena can edit the pages you share. It only ever makes new ones, under a page you pick.";
  };

  async function choose(): Promise<boolean> {
    const parent = await pickNotionParent(connectorId);
    if (!parent) return false;
    try {
      state = await saveNotionParent(connectorId, parent);
      showToast(`New pages go under ${parent.title}`, { icon: "check" });
      paint();
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't save that", { icon: "close" });
      return false;
    }
  }

  sw.addEventListener("change", async () => {
    sw.disabled = true;
    try {
      if (sw.checked) {
        if (!(await choose())) sw.checked = false;
      } else {
        state = await saveNotionParent(connectorId, null);
        showToast("Athena won't make pages in Notion now", { icon: "check" });
        paint();
      }
    } catch (error) {
      sw.checked = !sw.checked;
      showToast(error instanceof Error ? error.message : "Couldn't change that", { icon: "close" });
    } finally {
      sw.disabled = false;
    }
  });

  wrap.append(
    group(
      "Pages",
      h(
        "div",
        { class: "card card--flush list" },
        h(
          "div",
          { class: "row tool-row" },
          h("span", { class: "tile tile--sm" }, icons.pen()),
          h("span", { class: "row__body" }, h("span", { class: "row__title" }, "Let Athena create pages"), h("span", { class: "row__meta" }, "Notes you send go under a page you pick")),
          sw
        )
      ),
      parentRow,
      hint
    )
  );
  paint();
  void loadNotionWrite(connectorId).then((s) => {
    state = s;
    paint();
  }, () => undefined);
  return wrap;
}

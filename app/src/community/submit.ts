/**
 * "Submit to Community", at the foot of the assistant and flow share sheets and beside a skill's downloads. Athena
 * never publishes anything itself: this says what the owner does, in two steps, and opens the Community site's
 * `/submit/` page in the browser.
 *
 *   1. Put the downloaded folder in a public GitHub repository of yours.
 *   2. Share it on the Community site, which reviews it before listing it.
 *
 * The page's address comes from the server (GET /api/community/settings `submit`: `/submit/` at the catalogue's
 * host), so a copy pointed at another catalogue sends people there. Without a catalogue the piece hides. The link
 * opens with no referrer, so the site isn't told which Athena sent the owner.
 */
import "../styles/community.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { loadCommunityCheck } from "../db/community";
import { KIND_FILES, type ShareKind } from "../../../lib/share-kinds";
import { submitSteps } from "./words";

let submitUrl: Promise<string | null> | null = null;
/** The site's page for sending an item in, read once a visit. */
const submitPage = () => (submitUrl ??= loadCommunityCheck().then((s) => s.submit ?? null, () => null));

export function submitToCommunity(kind: ShareKind): HTMLElement {
  const id = `cm-submit-${kind}`;
  const steps = submitSteps(kind, KIND_FILES[kind]);
  const open = h("a", { class: "btn btn--soft btn--sm cm-submit__go", target: "_blank", rel: "noopener noreferrer" }, h("span", {}, "Open the Community site"), icons.external()) as HTMLAnchorElement;
  const panel = h(
    "div",
    { class: "cm-submit__panel", id: `${id}-panel`, hidden: true },
    h("p", { class: "cm-submit__lede" }, steps.lede),
    h(
      "ol",
      { class: "cm-submit__steps" },
      ...steps.steps.map((s, i) => h("li", { class: "cm-submit__step" }, h("span", { class: "cm-submit__n", "aria-hidden": "true" }, String(i + 1)), h("span", {}, h("span", { class: "cm-submit__title" }, s.title), h("span", { class: "cm-submit__sub" }, s.detail))))
    ),
    open,
    h("p", { class: "cm-submit__note" }, steps.note)
  );
  const toggle = h("button", { class: "cm-submit__toggle", type: "button", "aria-expanded": "false", "aria-controls": `${id}-panel` }, h("span", { class: "cm-submit__icon", "aria-hidden": "true" }, icons.globe()), h("span", { class: "cm-submit__words" }, h("span", { class: "cm-submit__label" }, "Submit to Community"), h("span", { class: "cm-submit__hint" }, steps.hint)), h("span", { class: "cm-submit__chevron", "aria-hidden": "true" }, icons.chevronDown())) as HTMLButtonElement;
  toggle.addEventListener("click", () => {
    const opening = panel.hidden;
    panel.hidden = !opening;
    toggle.setAttribute("aria-expanded", String(opening));
  });
  const el = h("section", { class: "cm-submit", "aria-label": "Submit to Community", hidden: true }, toggle, panel);
  void submitPage().then((url) => {
    if (!url) return;
    open.href = url;
    el.hidden = false;
  });
  return el;
}

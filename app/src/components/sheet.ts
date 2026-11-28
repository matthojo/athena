/**
 * Bottom sheet on a native <dialog> (focus trap, Escape, inert background for
 * free). Opening pushes a history entry so the system back gesture closes the
 * sheet instead of leaving the app. The grip/header zone drags: release past
 * 120px or with a downward flick and it dismisses from where your finger left
 * it; otherwise it settles back. Dragging up rubber-bands.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";

export interface SheetOptions {
  label: string;
  title?: string;
  body: HTMLElement;
  variant?: "compose" | "tall";
  onClose?: () => void;
}

export interface SheetHandle {
  dialog: HTMLDialogElement;
  close: () => void;
  /** Multi-step sheets: retitle, and show a back button (null hides it). */
  setTitle: (title: string) => void;
  setBack: (run: (() => void) | null) => void;
}

// The on-screen keyboard's height as --kb (iOS shrinks only the visual
// viewport when it opens), so sheets can sit on top of it like native ones.
const vv = window.visualViewport;
if (vv) {
  const syncKeyboard = () => {
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty("--kb", `${kb}px`);
    document.documentElement.classList.toggle("kb-open", kb > 80);
  };
  vv.addEventListener("resize", syncKeyboard);
  vv.addEventListener("scroll", syncKeyboard);
  syncKeyboard();
}

// A sheet closed by history.back() lands a beat later, on popstate. A sheet
// opened in that gap (close one, open the next) must wait for it: otherwise
// its own history entry takes the back, and it closes the moment it opens.
let pendingBack: Promise<void> | null = null;

function backThen(): void {
  pendingBack = new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("popstate", done);
      pendingBack = null;
      resolve();
    };
    const timer = setTimeout(done, 600);
    window.addEventListener("popstate", done);
  });
  history.back();
}

/** Resolves once a sheet that just closed has given its history entry back: navigate after this, or the back undoes it. */
export const afterSheetClosed = (): Promise<void> => pendingBack ?? Promise.resolve();

let sheetSeq = 0;
// Unique across reloads: a sheet entry can outlive the page (iOS reloads a
// backgrounded PWA), and a restarted counter would collide with it.
const sessionTag = Date.now().toString(36);

export function openSheet(opts: SheetOptions): SheetHandle {
  const id = `${sessionTag}-${++sheetSeq}`;
  const closeBtn = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": "Close" }, icons.close());
  const backBtn = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost sheet__back", type: "button", "aria-label": "Back", hidden: true }, icons.back());
  const titleEl = opts.title ? h("h2", { class: "sheet__title" }, opts.title) : h("span", {});
  const drag = h(
    "div",
    { class: "sheet__drag" },
    h("div", { class: "sheet__grip", "aria-hidden": "true" }),
    h("div", { class: "sheet__head" }, h("div", { class: "sheet__lead" }, backBtn, titleEl), closeBtn)
  );
  let onBack: (() => void) | null = null;
  backBtn.addEventListener("click", () => onBack?.());
  // showModal() focuses the first focusable element — the close button — and
  // rings it. Land focus on the panel itself so reading starts at the top.
  const panel = h("div", { class: "sheet__panel", tabindex: -1, autofocus: true }, drag, h("div", { class: "sheet__scroll" }, opts.body));
  const dialog = h(
    "dialog",
    { class: `sheet${opts.variant ? ` sheet--${opts.variant}` : ""}`, "aria-label": opts.label },
    panel
  ) as HTMLDialogElement;

  let finished = false;

  function finish() {
    if (finished) return;
    finished = true;
    window.removeEventListener("popstate", onPop);
    dialog.classList.add("is-closing");
    let gone = false;
    // Whichever comes first: the closing animation's end, or the fallback timer.
    const done = () => {
      if (gone) return;
      gone = true;
      dialog.close();
      dialog.remove();
      opts.onClose?.();
    };
    panel.addEventListener("animationend", done, { once: true });
    setTimeout(done, 320);
  }

  function requestClose() {
    if (finished) return;
    if ((history.state as { athenaSheet?: string } | null)?.athenaSheet === id) backThen();
    else finish();
  }

  function onPop() {
    if ((history.state as { athenaSheet?: string } | null)?.athenaSheet !== id) finish();
  }

  closeBtn.addEventListener("click", requestClose);
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    requestClose();
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) requestClose();
  });
  // The rich-text editor marks Escape as handled, which suppresses the
  // dialog's own `cancel`. Close from it anyway, unless Escape is dismissing
  // an @-suggestion menu first.
  dialog.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !(e.target as Element | null)?.closest?.(".ProseMirror")) return;
      if (document.querySelector(".mention-menu")) return;
      e.preventDefault();
      requestClose();
    },
    true
  );

  // ---------- Drag to dismiss ----------
  const desktopCompose = () => opts.variant === "compose" && window.matchMedia("(min-width: 640px)").matches;
  let startY = 0;
  let startT = 0;
  let dy = 0;
  let dragging = false;

  drag.addEventListener("pointerdown", (e) => {
    if (desktopCompose() || (e.target as Element).closest("button")) return;
    dragging = true;
    startY = e.clientY;
    startT = performance.now();
    dy = 0;
    drag.setPointerCapture(e.pointerId);
    dialog.classList.add("is-dragging");
  });

  drag.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const raw = e.clientY - startY;
    dy = raw < 0 ? raw * 0.2 : raw;
    panel.style.setProperty("--drag", `${dy}px`);
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    dialog.classList.remove("is-dragging");
    const velocity = dy / Math.max(1, performance.now() - startT);
    if (dy > 120 || (dy > 24 && velocity > 0.6)) {
      requestClose();
      return;
    }
    dialog.classList.add("is-settling");
    panel.style.setProperty("--drag", "0px");
    setTimeout(() => dialog.classList.remove("is-settling"), 360);
  };
  drag.addEventListener("pointerup", endDrag);
  drag.addEventListener("pointercancel", endDrag);

  document.body.append(dialog);
  dialog.showModal();
  // Take a history entry for the back gesture, once any closing sheet's back has landed.
  const arm = () => {
    if (finished) return;
    history.pushState({ ...(history.state ?? {}), athenaSheet: id }, "");
    window.addEventListener("popstate", onPop);
  };
  if (pendingBack) void pendingBack.then(arm);
  else arm();

  return {
    dialog,
    close: requestClose,
    setTitle(title) {
      titleEl.textContent = title;
      if (!titleEl.classList.contains("sheet__title")) titleEl.className = "sheet__title";
    },
    setBack(run) {
      onBack = run;
      backBtn.hidden = !run;
    },
  };
}

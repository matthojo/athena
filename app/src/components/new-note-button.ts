/**
 * New note, on a phone's Home: the dock no longer has a
 * floating + beside it, so Home carries its own button. Wide screens hide it:
 * the sidebar's New note (C) is there.
 */
import { h } from "../lib/dom";
import { icons } from "./icons";

export function newNoteButton(compose: () => void): HTMLButtonElement {
  const b = h("button", { class: "new-note-btn", type: "button" }, icons.plus(), h("span", {}, "New note")) as HTMLButtonElement;
  b.addEventListener("click", compose);
  return b;
}

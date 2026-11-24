/**
 * Settings → Ask: "Check the Community catalogue" (lib/community-config.ts). The same switch as the line on the
 * Community page. While it's on, Athena's server reads the catalogue's list once a day and an item's files when
 * one is opened; while it's off it contacts the catalogue for nothing. Adding from a file or a link works either way.
 * Built like ask-web-setting.ts.
 */
import "../styles/life.css";
import "../styles/community.css";
import { h } from "../lib/dom";
import { showToast } from "../components/toast";
import { loadCommunityCheck, setCommunityCheck } from "../db/community";
import { communityHash } from "./words";

export function communitySetting(): HTMLElement {
  const id = "community-setting";
  const input = h("input", { type: "checkbox", role: "switch", class: "switch", id, "aria-describedby": `${id}-sub`, disabled: true }) as HTMLInputElement;
  const sub = h("span", { class: "life-prefs__sub", id: `${id}-sub` }, "Lets you browse assistants, skills and flows other people shared, and hear about updates to ones you added. Athena's server reads the list once a day. Nothing about you is sent.");
  const browse = h("a", { class: "cm-setting__link", href: communityHash() }, "Browse Community");
  void loadCommunityCheck().then(
    ({ on, configured }) => {
      input.checked = on && configured;
      input.disabled = !configured;
      if (!configured) {
        sub.textContent = "This Athena has no catalogue address, so there's nothing to check.";
        browse.hidden = true;
      }
    },
    () => undefined
  );
  input.addEventListener("change", async () => {
    const on = input.checked;
    input.disabled = true;
    try {
      await setCommunityCheck(on);
      showToast(on ? "Athena will check the Community catalogue" : "Athena won't contact the Community catalogue", { icon: "check" });
    } catch {
      input.checked = !on;
      showToast("That didn't save. Check you're online", { icon: "wifiOff" });
    } finally {
      input.disabled = false;
    }
  });
  return h(
    "div",
    { class: "cm-setting", "data-setting": "community" },
    h("label", { class: "life-prefs__row", for: id }, h("span", { class: "life-prefs__words" }, h("span", { class: "life-prefs__name" }, "Check the Community catalogue"), sub), input),
    browse
  );
}

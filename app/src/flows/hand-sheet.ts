/**
 * Handing a flow to an assistant (mockup 8): who should run it, from the
 * team or a new one, and what changes when it does. And the other way
 * round, from an assistant's page: Give <Name> a flow, from your plain ones.
 */
import { h } from "../lib/dom";
import { openSheet } from "../components/sheet";
import { showToast } from "../components/toast";
import { listTeam, type TeamAssistant } from "../db/team";
import { handFlow, listFlows, type Flow } from "../db/flows";
import { MAX_ASSISTANTS } from "../../../lib/team-types";
import { pronouns } from "../team/detail-words";
import { chain, face, flowIcon } from "./parts";
import { triggerWords } from "./words";

/** What changes when `who` runs it. `who` is null for a new assistant. */
export function changeLines(who: Pick<TeamAssistant, "name" | "personality"> | null): string[] {
  const mid = who ? who.name : "the new assistant";
  const cap = who ? who.name : "The new assistant";
  const they = who ? pronouns(who.personality).they : "it";
  return [
    `Its runs come from ${mid}, on Home and on Team.`,
    `${cap} can think between steps. Those steps use AI credits.`,
    `${cap} remembers what you decide, like which renewals you always let run.`,
    `Anything ${they === "it" ? mid : they} isn't allowed to do alone still waits for your Go.`,
  ];
}

export function openHandSheet(o: { flow: Flow; onHanded: (f: Flow) => void }): void {
  const list = h("div", { class: "flow-who-list", role: "radiogroup", "aria-label": "Assistant" });
  const changes = h("ul", { class: "flow-changes" });
  const go = h("button", { class: "btn btn--primary btn--block", type: "button", disabled: true }, "Hand it over");
  const body = h(
    "div",
    { class: "flow-sheet" },
    h("p", { class: "flow-sheet__lede" }, "It keeps every step you made. The assistant can add thinking steps between them."),
    list,
    h("div", { class: "flow-sheet__group" }, h("span", { class: "flow-field__label" }, "What changes"), changes),
    h("div", { class: "flow-sheet__foot" }, go, h("p", { class: "flow-note flow-note--centre" }, "Take it back whenever you like. It becomes a plain flow again."))
  );
  const sheet = openSheet({ label: "Hand to an assistant", title: `Who should run ${o.flow.name}?`, body, variant: "tall" });
  let team: TeamAssistant[] = [];
  let picked: string | null = null;

  const paint = () => {
    const who = team.find((a) => a.id === picked) ?? null;
    list.querySelectorAll<HTMLButtonElement>("[role=radio]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.id === picked)));
    changes.replaceChildren(...changeLines(picked === "new" ? null : who).map((l) => h("li", {}, flowIcon("check"), h("span", {}, l))));
    go.disabled = !picked;
    go.textContent = picked === "new" ? "Make an assistant for it" : who ? `Hand to ${who.name}` : "Hand it over";
  };

  const option = (id: string, lead: HTMLElement, name: string, job: string) => {
    const b = h("button", { class: "flow-who-opt", type: "button", role: "radio", "aria-checked": "false", "data-id": id }, lead, h("span", { class: "flow-who-opt__text" }, h("b", {}, name), h("small", {}, job)), h("span", { class: "flow-radio", "aria-hidden": "true" }));
    b.addEventListener("click", () => {
      picked = id;
      paint();
    });
    return b;
  };

  void listTeam()
    .then((t) => {
      team = t;
      const opts = t.map((a) => option(a.id, face(a.avatar, 44), a.name, a.job || "No job yet"));
      if (t.length < MAX_ASSISTANTS) opts.push(option("new", h("span", { class: "flow-who-opt__blank", "aria-hidden": "true" }, flowIcon("plus")), "A new assistant", "Athena makes one for this flow"));
      list.replaceChildren(...opts);
      picked = t[0]?.id ?? "new";
      paint();
    })
    .catch(() => list.replaceChildren(h("p", { class: "flow-note" }, "Your team didn't load. Check you're online and try again.")));

  go.addEventListener("click", async () => {
    if (!picked) return;
    go.disabled = true;
    try {
      const f = await handFlow(o.flow.id, picked);
      const who = team.find((a) => a.id === f.assistant_id);
      sheet.close();
      showToast(who ? `${who.name} runs ${f.name} now` : `${f.name} has an assistant now`);
      o.onHanded(f);
    } catch (e) {
      go.disabled = false;
      showToast(e instanceof Error && e.message ? `Couldn't hand it over: ${e.message}` : "Couldn't hand it over. Try again.");
    }
  });
}

/** From an assistant's page: pick one of your plain flows for them to run. */
export function openGiveSheet(o: { assistant: TeamAssistant; onGiven: (f: Flow) => void; onNew: () => void }): void {
  const list = h("div", { class: "flow-give-list" });
  const make = h("button", { class: "btn btn--soft btn--block", type: "button" }, flowIcon("plus"), "Make a new flow");
  const body = h("div", { class: "flow-sheet" }, h("p", { class: "flow-sheet__lede" }, `${o.assistant.name} keeps its steps, and can add thinking steps between them.`), list, make);
  const sheet = openSheet({ label: `Give ${o.assistant.name} a flow`, title: `Give ${o.assistant.name} a flow`, body, variant: "tall" });
  make.addEventListener("click", () => {
    sheet.close();
    window.setTimeout(o.onNew, 450);
  });
  void listFlows()
    .then(({ flows }) => {
      const plain = flows.filter((f) => !f.assistant_id);
      if (!plain.length) return void list.replaceChildren(h("p", { class: "flow-note" }, "All your flows have an assistant already."));
      list.replaceChildren(
        ...plain.map((f) => {
          const b = h("button", { class: "flow-give", type: "button" }, h("span", { class: "flow-give__text" }, h("b", {}, f.name), h("small", {}, triggerWords(f.trigger))), chain(f, 4));
          b.addEventListener("click", async () => {
            b.disabled = true;
            try {
              const next = await handFlow(f.id, o.assistant.id);
              sheet.close();
              showToast(`${o.assistant.name} runs ${next.name} now`);
              window.setTimeout(() => o.onGiven(next), 450);
            } catch {
              b.disabled = false;
              showToast("Couldn't hand it over. Try again.");
            }
          });
          return b;
        })
      );
    })
    .catch(() => list.replaceChildren(h("p", { class: "flow-note" }, "Your flows didn't load. Check you're online and try again.")));
}

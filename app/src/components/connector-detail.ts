/**
 * Detail for one account or one collection, shown in a sheet. Laid out like
 * a record profile: identity header, then grouped rows.
 *
 * An account leads with its problem, if it has one, worded as what's wrong
 * and with the fix as its only button (or a key field right there). Then
 * the collections that read it, what Athena can read (folded to one line,
 * opening to a phone-style permission list where tools that change data
 * show Never and can't be switched on; the server refuses too), technical
 * details folded, and a quiet footer.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { confirmDialog } from "./confirm";
import { connectorLogo } from "./brand-logo";
import { plural, relativeTime } from "../lib/format";
import { checkConnector, deleteConnector, updateConnector } from "../db/api";
import { checkTools, openEditAccount, openRenameAccount, signInWhere, startSignIn } from "./connector-forms";
import { keyGuide, keyShape, setupBlock } from "./setup-steps";
import { openConnected, type ConnectedContext } from "./account-connected";
import { lastImportTitle, serverImportTitle, type ImportLine } from "../lib/youtube-import-memo";
import { calendarsGroup } from "./calendar-picker";
import { accountMailPort, mailRulesGroup } from "./mail-rules";
import {
  errorText,
  RECIPE_ICON,
  scheduleText,
  serviceLabel,
  statusLine,
  toolTitle,
  trail,
} from "../lib/connectors-ui";
import { canDraft, canMove, canRsvp, directApi, DRAFT_SCOPE, EVENTS_SWITCH, GMAIL_READ_SCOPE, isCustomServer, MOVE_PROVIDERS, presetFor, RSVP_SCOPE } from "../../../lib/connector-presets";
import { setAnswering } from "../lib/rsvp-switch";
import { setMoving } from "../lib/move-switch";
import "../styles/scheduling.css";
import { notionWriteGroup } from "./notion-write";
import { carVehiclesGroup } from "./car-vehicles";
import { historyRow, loadsHistory } from "./history-load";
import type { Connector, ConnectorsState, ConnectorTool } from "../types";

export interface DetailContext {
  state: () => ConnectorsState;
  /** Reload everything (list and this detail). */
  reload: () => Promise<void>;
  /** The thing shown was removed. */
  closed: () => void;
  openAccount: (id: string) => void;
  /** Open a collection (an account's "Used by" rows are buttons when this is given). */
  openCollection?: (id: string) => void;
  /** Slice C's collection form, for the connected sheet's "Change the time…". */
  openCollectionForm?: ConnectedContext["openCollectionForm"];
}

export interface DetailView {
  el: HTMLElement;
  id: string;
  destroy: () => void;
}

const group = (label: string | null, ...children: Array<HTMLElement | null>) =>
  h("section", { class: "group" }, label ? h("h3", { class: "group__label" }, label) : null, ...children);

/** A custom server's own fields (lib/connectors.ts): a tool's text changed since it was allowed, and the two switches. */
type PinnedTool = ConnectorTool & { changed?: boolean };
type CustomSwitches = { use_in_ask?: boolean; share_collections?: boolean };

/** A read-only label/value row. */
/** Calendar accounts with the calendar picker (calendar-picker.ts). */
const PICKS_CALENDARS = new Set(["google-calendar", "outlook-calendar", "icloud-calendar"]);

const fact = (label: string, value: string | HTMLElement) =>
  h("div", { class: "prop prop--fact" }, h("span", { class: "prop__label" }, label), h("span", { class: "prop__value" }, value));

/** A trailing text-style select ("Allowed ›"), native so phones get their own picker. */
function permSelect(label: string, options: Array<[string, string, boolean?]>, value: string): HTMLSelectElement {
  const s = h("select", { class: "perm", "aria-label": label }, ...options.map(([v, l, disabled]) => h("option", { value: v, disabled: !!disabled }, l))) as HTMLSelectElement;
  s.value = value;
  s.dataset.value = value;
  return s;
}

// ---------- Account ----------

/** What's wrong with an account, worded for you, and the one thing that fixes it. */
export interface AccountProblem {
  kind: "finish" | "signin" | "permission" | "admin" | "secret" | "client" | "key" | "settings" | "down" | "fix";
  title: string;
  line: string;
  /** The fix button's words; null when the fix is inline (a key or secret field) or there's nothing to press. */
  button: string | null;
}

const CLIENT_SECRET_EXPIRED = /client secret has expired|secret keys? .*expired|AADSTS7000222/i;
const CLIENT_REFUSED = /can't find an app with that client ID|refused Athena's app|only accepts accounts from its own organisation|invalid_client|unauthorized_client|AADSTS(7000215|700016|50194|700054)/i;

/**
 * One account's problem, if it has one. Sources' health line words its
 * cards the same way (`usedBy` is the names of the collections reading it).
 */
export function accountProblem(c: Connector, usedBy: string[] = []): AccountProblem | null {
  if (c.status === "connected") return null;
  const where = signInWhere(c);
  const detail = c.status_detail || "";
  const waiting = usedBy.length ? ` ${usedBy.length > 1 ? `${usedBy[0]} and ${usedBy.length - 1} more are` : `${usedBy[0]} is`} waiting on it.` : "";
  if (c.status === "pending") return { kind: "finish", title: `Finish connecting ${c.name}`, line: "Sign in so Athena can read it.", button: `Sign in to ${where}` };
  if (/IT admin/i.test(detail)) return { kind: "admin", title: "Needs your IT admin", line: `Your organisation has to approve Athena first. Ask your IT admin, then sign in again.`, button: `Sign in to ${where}` };
  if (CLIENT_SECRET_EXPIRED.test(detail)) return { kind: "secret", title: `Your ${where} secret expired`, line: `Make a new one and paste it here.${waiting}`, button: null };
  if (CLIENT_REFUSED.test(detail))
    return {
      kind: "client",
      title: `${where} turned down Athena's app`,
      line: detail.replace(/^Sign-in failed:\s*/i, "").replace(/under Edit/g, "in Sign-in settings").replace(/AADSTS\d+:?\s*/g, ""),
      button: "Sign-in settings",
    };
  // Nothing to sign in to (a public profile), or an address to fix: the service's own words, and Check again once it's sorted.
  if (c.status === "needs_auth" && (c.auth_type === "none" || /add it again|profile link/i.test(detail)) && detail)
    return { kind: "fix", title: `Athena can't read ${c.name}`, line: `${detail}${waiting}`, button: "Check again" };
  // An address asked for as fields (Octopus's meters) that the service can't find: fix it in Sign-in settings, not the key.
  if (c.status === "needs_auth" && c.auth_type === "token" && presetFor(c.provider).address?.fields && /can't find that/i.test(detail))
    return { kind: "settings", title: `Athena can't read ${c.name}`, line: `${detail.replace(/under Edit/g, "in Sign-in settings")}${waiting}`, button: "Sign-in settings" };
  if (c.status === "needs_auth" && c.auth_type === "token" && /app-specific password/i.test(detail))
    return { kind: "key", title: "Apple turned down the password", line: `Make a new app-specific password and paste it here.${waiting}`, button: null };
  if (c.status === "needs_auth" && c.auth_type === "token") return { kind: "key", title: `${c.name}'s key stopped working`, line: `Paste a new one.${waiting}`, button: null };
  if (c.status === "needs_auth" && c.oauth?.grant === "client_credentials") return { kind: "settings", title: `${c.name} can't get access`, line: "Check its client ID, secret and scope.", button: "Sign-in settings" };
  if (/HTTP 403|allow every permission|missing permission|permission/i.test(detail) && c.status === "needs_auth") {
    const api = /enabled in your Google Cloud project/i.test(detail);
    return { kind: "permission", title: `${where} turned Athena away`, line: api ? "Check the API is on in Google Cloud, then sign in again and tick every box." : "Sign in again and tick every box it asks for.", button: `Sign in to ${where}` };
  }
  if (c.status === "needs_auth" || /^Sign-in failed/i.test(detail)) {
    const unfinished = /cancelled or refused|Waiting for you to finish|Not signed in yet|^Sign-in failed/i.test(detail);
    return { kind: "signin", title: unfinished ? "Sign-in didn't finish" : `${c.name} is signed out`, line: unfinished ? "Try once more." : waiting.trim() || "Sign in so Athena can read it again.", button: `Sign in to ${where}` };
  }
  return { kind: "down", title: `${c.name} isn't answering`, line: "Athena will try again on the next run.", button: "Check now" };
}

/** "Working · read 2 hours ago". */
function workingText(c: Connector): string {
  return c.last_used_at ? `Working · read ${relativeTime(c.last_used_at)}` : "Working";
}

export function accountDetail(c: Connector, ctx: DetailContext): DetailView {
  const preset = presetFor(c.provider);
  // Netflix: nothing to sign in to, read or check; its page is the import (lib/presets/netflix.ts).
  const importOnly = c.provider === "netflix";
  const where = signInWhere(c);
  const cc = c.auth_type === "oauth" && c.oauth?.grant === "client_credentials";
  // iCloud: the other accounts a new password reaches too (the server updates the ones that shared the old one).
  const sharesKey = preset.username ? ctx.state().connectors.filter((x) => x.id !== c.id && x.auth_type === "token" && presetFor(x.provider).username?.label === preset.username!.label) : [];
  const sharedLine = sharesKey.length ? `If ${sharesKey.map((x) => x.name).join(" or ")} uses the same password, it's updated too.` : null;
  const settings = () => openEditAccount(c, () => void ctx.reload(), ctx.state().setup.callback_url, sharedLine);
  const connectedCtx = { reload: ctx.reload, openCollection: ctx.openCollection, openCollectionForm: ctx.openCollectionForm };
  /** Sign in (browser) or get new access (client credentials), then refresh this pane. */
  async function signIn() {
    if ((await startSignIn(c)) === "done") await ctx.reload();
  }
  const drafting = canDraft(c);
  const reads = c.tools.filter((t) => t.access === "read");
  const unknown = c.tools.filter((t) => t.access === "unknown");
  const writes = c.tools.filter((t) => t.access === "write");
  let allowed = new Set(c.allowed_tools);
  const custom = isCustomServer(c.provider);
  // Allowed, but the server changed what the tool says since: Athena doesn't use it until it's approved again.
  const changedTools = () => (c.tools as PinnedTool[]).filter((t) => t.changed && allowed.has(t.name));
  const usedBy = ctx.state().collections.filter((col) => col.connector_ids.includes(c.id));
  const problem = accountProblem(c, usedBy.map((col) => col.name));

  async function saveAllowed(next: Set<string>, undo: () => void) {
    try {
      const updated = await updateConnector(c.id, { allowed_tools: [...next] });
      allowed = new Set(updated.allowed_tools);
      c.allowed_tools = updated.allowed_tools;
      paintAll();
      void ctx.reload();
    } catch (err) {
      undo();
      showToast(errorText(err, "Couldn't change that"), { icon: "close" });
    }
  }

  // ----- What Athena can read -----

  // "Everything it can read", nothing, or your own pick.
  const allSelect = permSelect("Everything", [["read", "Every read"], ["none", "Nothing"], ["custom", "Your pick", true]], "read");
  const countTitle = h("span", { class: "row__title" });
  const namesLine = h("span", { class: "row__meta acct-perms__names" });
  function paintAll() {
    const allReadOn = reads.every((t) => allowed.has(t.name));
    const anyOn = allowed.size > 0;
    const v = !anyOn ? "none" : allReadOn && unknown.every((t) => !allowed.has(t.name)) ? "read" : "custom";
    allSelect.value = v;
    allSelect.dataset.value = v;
    for (const s of toolSelects) {
      s.el.value = allowed.has(s.tool.name) ? "on" : "off";
      s.el.dataset.value = s.el.value;
    }
    const readable = [...reads, ...unknown];
    const on = readable.filter((t) => allowed.has(t.name));
    countTitle.textContent = on.length ? `${on.length} of ${readable.length} ${plural(readable.length, "read", "reads")} allowed` : "Nothing allowed";
    const waiting = changedTools().length;
    namesLine.textContent = waiting
      ? `${waiting} changed, ${plural(waiting, "needs", "need")} re-approval`
      : on.length
        ? on.map((t) => toolTitle(t.name, c.provider)).join(", ")
        : "Collections and Ask skip this account.";
  }
  allSelect.addEventListener("change", () => {
    const before = new Set(allowed);
    const next = allSelect.value === "read" ? new Set(reads.map((t) => t.name)) : new Set<string>();
    void saveAllowed(next, () => {
      allowed = before;
      paintAll();
    });
  });

  const toolSelects: Array<{ tool: ConnectorTool; el: HTMLSelectElement }> = [];
  function toolRow(t: ConnectorTool): HTMLElement {
    const title = toolTitle(t.name, c.provider);
    let control: HTMLElement;
    let approve: HTMLButtonElement | null = null;
    if (t.access === "write" && t.name === "create_draft" && drafting) {
      control = h("span", { class: "perm perm--draft" }, icons.mail(), "Drafts only");
    } else if (t.access === "write") {
      control = h("span", { class: "perm perm--blocked" }, icons.close(), "Never");
    } else {
      const s = permSelect(`${title}: allowed or off`, [["on", "Allowed"], ["off", "Off"]], allowed.has(t.name) ? "on" : "off");
      s.addEventListener("change", () => {
        const before = new Set(allowed);
        const next = new Set(allowed);
        if (s.value === "on") next.add(t.name);
        else next.delete(t.name);
        void saveAllowed(next, () => {
          allowed = before;
          paintAll();
        });
      });
      toolSelects.push({ tool: t, el: s });
      control = s;
      if ((t as PinnedTool).changed && allowed.has(t.name)) {
        approve = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": `Approve ${title} as it reads now` }, "Approve") as HTMLButtonElement;
        approve.addEventListener("click", async () => {
          approve!.disabled = true;
          try {
            await updateConnector(c.id, { approve_tools: [t.name] });
            showToast(`${title} approved`, { icon: "check" });
            await ctx.reload();
          } catch (err) {
            approve!.disabled = false;
            showToast(errorText(err, "Couldn't approve that"), { icon: "close" });
          }
        });
      }
    }
    const changed = (t as PinnedTool).changed && allowed.has(t.name);
    return h(
      "div",
      { class: `row tool-row tool-row--${t.access}`, title: t.description || t.name },
      h(
        "span",
        { class: "row__body", style: changed ? "grid-column: 1 / 3; min-width: 0" : undefined },
        h("span", { class: "row__title" }, title),
        changed ? statusLine("warn", "Changed, needs re-approval") : null,
        // A changed tool's new text is what's being approved: shown whole, not cut to one line.
        h("span", { class: "row__meta tool-row__desc", style: changed ? "white-space: normal; overflow: visible; display: block" : undefined }, t.description || t.name),
        approve ? h("span", { style: "display: block; margin-top:var(--space-xs)" }, approve) : null
      ),
      control
    );
  }

  const permissions = c.tools.length
    ? group(
        "What Athena can read",
        h(
          "details",
          { class: "card card--flush acct-perms", open: changedTools().length > 0 },
          h(
            "summary",
            { class: "row acct-perms__summary" },
            h("span", { class: "tile tile--sm" }, icons.checklist()),
            h("span", { class: "row__body" }, countTitle, namesLine),
            h("span", { class: "acct-perms__choose" }, "Choose", h("span", { class: "acct-perms__chev", "aria-hidden": "true" }, icons.chevronDown()))
          ),
          h(
            "div",
            { class: "acct-perms__body" },
            reads.length ? h("div", { class: "list" }, h("div", { class: "row tool-row tool-row--all" }, h("span", { class: "row__body" }, h("span", { class: "row__title" }, "Everything it can read")), allSelect)) : null,
            reads.length ? h("p", { class: "acct-perms__label" }, "Reads") : null,
            reads.length ? h("div", { class: "list" }, ...reads.map(toolRow)) : null,
            unknown.length ? h("p", { class: "acct-perms__label" }, "Might change things") : null,
            unknown.length
              ? h(
                  "p",
                  { class: "form__hint acct-perms__hint" },
                  custom
                    ? "Athena doesn't take a server's word for what its tools do, so each one starts off. Read what it does before allowing it. If its description changes later, Athena stops using it until you approve it again."
                    : `${serviceLabel(c)} doesn't say whether these change anything. Read what each does before allowing it.`
                )
              : null,
            unknown.length ? h("div", { class: "list" }, ...unknown.map(toolRow)) : null,
            writes.length ? h("p", { class: "acct-perms__label" }, drafting ? "Changes things · only drafts are used" : "Changes things · never used") : null,
            writes.length ? h("div", { class: "list" }, ...writes.map(toolRow)) : null
          )
        ),
        h("p", { class: "form__hint" }, "Collections and Ask only use what's allowed here, and only to read. Changes apply from the next run.")
      )
    : group(
        "What Athena can read",
        h(
          "div",
          { class: "card empty empty--compact" },
          h("p", { class: "empty__title" }, problem?.kind === "down" ? `Shows once ${c.name} answers` : c.tools_checked_at && c.status === "connected" ? `${serviceLabel(c)} offers nothing to read` : "Shows once you're signed in"),
          h("p", { class: "empty__sub" }, problem?.kind === "down" ? "Athena lists what it can read and allows only reading." : c.tools_checked_at && c.status === "connected" ? "Check again later, or remove the account." : "Athena lists what it can read and allows only reading.")
        )
      );

  // ----- A custom server: where its tools may sit beside your other accounts (both off until you say) -----

  function sharingGroup(): HTMLElement {
    const row = (field: keyof CustomSwitches, icon: SVGElement | HTMLElement, title: string, line: string) => {
      const sw = h("input", { type: "checkbox", role: "switch", class: "switch", "aria-label": title }) as HTMLInputElement;
      sw.checked = (c as Connector & CustomSwitches)[field] === true;
      sw.addEventListener("change", async () => {
        const next = sw.checked;
        sw.disabled = true;
        try {
          await updateConnector(c.id, { [field]: next });
          await ctx.reload();
        } catch (err) {
          sw.checked = !next;
          showToast(errorText(err, "Couldn't change that"), { icon: "close", timeoutMs: 6000 });
        } finally {
          sw.disabled = false;
        }
      });
      return h("div", { class: "row tool-row" }, h("span", { class: "tile tile--sm" }, icon), h("span", { class: "row__body" }, h("span", { class: "row__title" }, title), h("span", { class: "row__meta" }, line)), sw);
    };
    return group(
      "With your other accounts",
      h(
        "div",
        { class: "card card--flush list" },
        row("use_in_ask", icons.sparkle(), "Use in Ask", `Ask can read ${c.name} when it answers, alongside your mail, calendar and other accounts.`),
        row("share_collections", icons.checklist(), "Share collections", `A collection can read ${c.name} together with other accounts, instead of only on its own.`)
      ),
      h("p", { class: "form__hint" }, `Both start off. While they're off, nothing ${c.name} says can reach a run that also reads your mail or calendar.`)
    );
  }

  /** What a live source is used for, and what it's sent. */
  function liveUse(live: NonNullable<typeof preset.live>): HTMLElement {
    return group("What Athena uses it for", h("div", { class: "card empty empty--compact" }, h("p", { class: "empty__title" }, live.added.title), h("p", { class: "empty__sub" }, `${live.added.sentence} ${live.foot}`)));
  }

  // ----- The problem, with its fix -----

  function problemBox(p: AccountProblem): HTMLElement {
    const tone = p.kind === "down" ? "info" : "warn";
    const fix = h("div", { class: "acct-problem__fix" });
    const icon = p.kind === "down" ? icons.wifiOff() : p.kind === "key" || p.kind === "secret" ? icons.key() : p.kind === "admin" ? icons.shield() : icons.plug();

    if (p.kind === "key" || p.kind === "secret") {
      // Paste the new key or secret right here.
      const input = h("input", { class: "prop__input", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "Paste it here", "aria-label": p.kind === "key" ? (preset.username ? "New app-specific password" : `New ${serviceLabel(c)} key`) : `New ${where} client secret` }) as HTMLInputElement;
      const state = h("p", { class: "acct-key__state", role: "status" });
      const save = h("button", { class: "btn btn--primary btn--block acct-problem__save", type: "button" }, p.kind === "key" ? "Check and save" : `Save and sign in`) as HTMLButtonElement;
      const field = h(
        "div",
        { class: "acct-key" },
        h("div", { class: "card card--flush fields acct-problem__field" }, h("div", { class: "prop" }, h("label", { class: "prop__label" }, p.kind === "key" ? (preset.username ? "New password" : "New key") : "New secret"), h("span", { class: "prop__control" }, input))),
        state,
        p.kind === "key" && sharedLine ? h("p", { class: "form__hint" }, sharedLine) : null
      );
      const guide =
        p.kind === "key"
          ? keyGuide(preset, field)
          : {
              steps: [
                preset.ownClientLabel === "Microsoft"
                  ? { title: "Make a new secret", sub: "Open your Athena app, then Certificates & secrets, then New client secret. Copy the Value, not the Secret ID.", open: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" }
                  : { title: "Make a new secret", sub: `In ${where}'s settings for your Athena app.` },
                { title: "Paste it here", fields: field },
              ],
            };
      async function submit() {
        const v = input.value.trim();
        if (!v) {
          input.focus();
          return;
        }
        const shape = p.kind === "key" ? keyShape(c.provider) : null;
        if (shape && !shape.test.test(v)) {
          state.className = "acct-key__state acct-key__state--warn";
          state.textContent = preset.username ? `That doesn't look like an app-specific password. ${shape.hint}` : `That doesn't look like a ${serviceLabel(c)} key. ${shape.hint}`;
          return;
        }
        save.disabled = true;
        state.className = "acct-key__state";
        state.textContent = p.kind === "key" ? `Checking with ${preset.username ? "Apple" : serviceLabel(c)}…` : "Saving…";
        try {
          await updateConnector(c.id, p.kind === "key" ? { token: v } : { client_secret: v });
          if (p.kind === "key") {
            try {
              await checkConnector(c.id);
            } catch {
              state.className = "acct-key__state acct-key__state--warn";
              state.textContent = preset.username ? "Apple didn't accept that password either. Check you copied all of it." : `${serviceLabel(c)} didn't accept that key either. Check you copied all of it.`;
              save.disabled = false;
              return;
            }
            showToast(`${c.name} is working again`, { icon: "check" });
            await ctx.reload();
          } else await signIn();
        } catch (err) {
          state.className = "acct-key__state acct-key__state--warn";
          state.textContent = errorText(err, "Couldn't save it.");
          save.disabled = false;
        }
      }
      save.addEventListener("click", () => void submit());
      input.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), void submit()));
      if (p.kind === "key") input.addEventListener("paste", () => setTimeout(() => void submit()));
      fix.append(setupBlock(guide), save);
    } else if (p.button) {
      const b = h("button", { class: `btn ${tone === "info" ? "btn--soft" : "btn--primary"} btn--sm acct-problem__btn`, type: "button", "aria-label": p.kind === "down" ? `Check ${c.name} now` : p.button === "Sign-in settings" ? `Sign-in settings for ${c.name}` : p.button }, p.button) as HTMLButtonElement;
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          if (p.kind === "client" || p.kind === "settings") settings();
          else if (p.kind === "down" || p.kind === "fix") {
            await checkTools(c);
            await ctx.reload();
          } else await signIn();
        } catch (err) {
          showToast(errorText(err, `Couldn't reach ${where}`), { icon: "close", timeoutMs: 6000 });
        } finally {
          b.disabled = false;
        }
      });
      fix.append(b);
    }
    return h(
      "section",
      { class: `acct-problem acct-problem--${tone}`, "aria-labelledby": `acct-problem-${c.id}` },
      h("span", { class: "acct-problem__icon" }, icon),
      h("div", { class: "acct-problem__body" }, h("h3", { class: "acct-problem__title", id: `acct-problem-${c.id}` }, p.title), h("p", { class: "acct-problem__line" }, p.line)),
      fix
    );
  }

  /**
   * Gmail and Outlook: let Athena save the emails it writes for you into this
   * account's Drafts. Each provider's permission for that is wider than
   * drafts (Google's covers sending, Microsoft's moving and deleting), so
   * it's asked for only when you turn this on (you sign in again); Athena
   * itself only ever calls create_draft.
   */
  function draftsGroup(): HTMLElement {
    const outlook = c.provider === "outlook-mail";
    const fastmail = c.provider === "fastmail";
    const scope = DRAFT_SCOPE[c.provider];
    const sw = h("input", { type: "checkbox", role: "switch", class: "switch", "aria-label": "Let Athena save drafts" }) as HTMLInputElement;
    sw.checked = drafting;
    sw.addEventListener("change", async () => {
      const on = sw.checked;
      sw.disabled = true;
      const scopes = new Set(c.scope.split(/\s+/).filter(Boolean));
      if (on) scopes.add(scope);
      else scopes.delete(scope);
      // Fastmail has no scopes of its own: its account's is just Athena's switch ("read" when drafts are off).
      if (!scopes.size) scopes.add(fastmail ? "read" : GMAIL_READ_SCOPE);
      try {
        await updateConnector(c.id, { scope: [...scopes].join(" ") });
        if (on && fastmail) {
          showToast("Drafts on for this account", { icon: "mail" });
          await ctx.reload();
        } else if (on) await signIn();
        else {
          showToast("Drafts off for this account", { icon: "mail" });
          await ctx.reload();
        }
      } catch (err) {
        sw.checked = !on;
        showToast(errorText(err, "Couldn't change that"), { icon: "close", timeoutMs: 6000 });
      } finally {
        sw.disabled = false;
      }
    });
    const off = fastmail
      ? "Fastmail's token needs Make changes ticked as well as Read data, which also covers moving and deleting mail. Athena only saves drafts: it never sends, moves or deletes. If your token is read-only, make a new one and paste it under Edit. Leave Send email off."
      : outlook
      ? "Microsoft's permission for drafts also covers moving and deleting mail, so Microsoft will ask for that. Athena only saves drafts: it never sends, moves or deletes. Turning this on asks you to sign in to Microsoft again."
      : "Google's permission for drafts also covers sending, so Google will say Athena could send email. It never does: Athena only saves drafts and blocks every send tool. Turning this on asks you to sign in to Google again.";
    return group(
      "Drafts",
      h(
        "div",
        { class: "card card--flush list" },
        h(
          "div",
          { class: "row tool-row" },
          h("span", { class: "tile tile--sm" }, icons.mail()),
          h("span", { class: "row__body" }, h("span", { class: "row__title" }, "Let Athena save drafts"), h("span", { class: "row__meta" }, "Emails Athena writes for you go into this account's Drafts")),
          sw
        )
      ),
      h("p", { class: "form__hint" }, drafting ? "Athena only ever saves drafts here. You check and send them yourself." : off)
    );
  }

  /**
   * Google Calendar, Outlook and iCloud Calendar: let Athena send your
   * Going, Maybe or Declined back to the calendar (lib/rsvp.ts). Google's
   * and Outlook's permission also covers editing events, so it's asked for
   * only when you turn this on; iCloud needs no new sign-in. Athena itself
   * only ever sends your reply.
   */
  function invitesGroup(): HTMLElement {
    const on = canRsvp(c);
    const icloud = c.provider === "icloud-calendar";
    const where = c.provider === "outlook-calendar" ? "Outlook" : icloud ? "iCloud Calendar" : "Google Calendar";
    const sw = h("input", { type: "checkbox", role: "switch", class: "switch", "aria-label": "Let Athena answer invites" }) as HTMLInputElement;
    sw.checked = on;
    sw.addEventListener("change", async () => {
      const next = sw.checked;
      sw.disabled = true;
      try {
        await setAnswering(c, next);
        if (next && icloud) {
          showToast("Answers go to iCloud Calendar now", { icon: "calendar" });
          await ctx.reload();
        } else if (next) await signIn();
        else {
          showToast("Answers stay in Athena now", { icon: "calendar" });
          await ctx.reload();
        }
      } catch (err) {
        sw.checked = !next;
        showToast(errorText(err, "Couldn't change that"), { icon: "close", timeoutMs: 6000 });
      } finally {
        sw.disabled = false;
      }
    });
    return group(
      "Invites",
      h(
        "div",
        { class: "card card--flush list" },
        h(
          "div",
          { class: "row tool-row" },
          h("span", { class: "tile tile--sm" }, icons.calendar()),
          h("span", { class: "row__body" }, h("span", { class: "row__title" }, "Let Athena answer invites"), h("span", { class: "row__meta" }, `Your Going, Maybe or Declined goes to ${where}`)),
          sw
        )
      ),
      h(
        "p",
        { class: "form__hint" },
        on
          ? canMove(c)
            ? "Answering only ever sends your answer. Adding and moving events is its own switch, below."
            : "Athena only sends your answer. It never adds, changes, moves or deletes events."
          : icloud
            ? "Your answers stay in Athena until this is on. Athena never changes anything else in iCloud."
            : `${where} will say Athena could change your events. Athena only ever sends your answer. You'll sign in again to turn this on.`
      )
    );
  }

  /**
   * "Let Athena add and update events": a new event (with invites) or a new
   * start and end for one of your own, from Ask, Check in or a to-do, after
   * you confirm. Its own switch, apart from answering invites; on Google and
   * Outlook it needs the same write permission, so it signs in again unless
   * that's already granted. It keeps the old moving switch's marker, so an
   * account that had moving on has this on.
   */
  function movingGroup(): HTMLElement {
    const on = canMove(c);
    const where = c.provider === "outlook-calendar" ? "Outlook" : c.provider === "icloud-calendar" ? "iCloud" : "Google Calendar";
    const sw = h("input", { type: "checkbox", role: "switch", class: "switch", "aria-label": EVENTS_SWITCH }) as HTMLInputElement;
    sw.checked = on;
    sw.addEventListener("change", async () => {
      const next = sw.checked;
      sw.disabled = true;
      try {
        const needsSignIn = await setMoving(c, next);
        if (needsSignIn) await signIn();
        else {
          showToast(next ? "Athena can add and move events now, after you confirm each one" : "Athena won't add or move events now", { icon: "calendar" });
          await ctx.reload();
        }
      } catch (err) {
        sw.checked = !next;
        showToast(errorText(err, "Couldn't change that"), { icon: "close", timeoutMs: 6000 });
      } finally {
        sw.disabled = false;
      }
    });
    return group(
      "Adding and moving events",
      h(
        "div",
        { class: "card card--flush list" },
        h(
          "div",
          { class: "row tool-row" },
          h("span", { class: "tile tile--sm" }, icons.calendar()),
          h("span", { class: "row__body" }, h("span", { class: "row__title row__title--wrap" }, EVENTS_SWITCH), h("span", { class: "row__meta" }, "New events with invites, and new times for yours. You confirm each one.")),
          sw
        )
      ),
      h(
        "p",
        { class: "form__hint" },
        on
          ? "Athena sends a new event's title, time, place, notes and guests, and moves only the start and end of events you organise. Undo removes only events Athena added."
          : c.provider === "icloud-calendar" || canRsvp(c)
            ? `Athena adds only events you confirm, and moves only events you organise in ${where}. It never deletes anything you made.`
            : `${where} will say Athena could change your events. It only adds events you confirm and moves ones you organise. You'll sign in again to turn this on.`
      )
    );
  }

  // ----- Used by -----

  const recipeFits = preset.recipes.some((r) => r !== "custom");
  function usedByGroup(): HTMLElement | null {
    if (!usedBy.length) {
      if (!recipeFits || problem) return null;
      const use = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": `Start collecting from ${c.name}` }, "Use it");
      use.addEventListener("click", () => openConnected(ctx.state(), c.id, connectedCtx));
      return group("Used by", h("div", { class: "card card--flush list" }, h("div", { class: "row acct-used" }, h("span", { class: "tile tile--sm" }, icons.clock()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, "Not used yet"), h("span", { class: "row__meta" }, "Nothing reads it on a schedule")), use)));
    }
    return group(
      "Used by",
      h(
        "div",
        { class: "card card--flush list" },
        ...usedBy.map((col) => {
          // What the problem costs, where it costs something.
          const cost = problem && problem.kind !== "down" ? (col.last_status === "failed" ? "Didn't run last time" : "Waiting on this account") : null;
          const inner = [
            h("span", { class: "tile tile--sm recipe-tile" }, icons[RECIPE_ICON[col.recipe]]()),
            h("span", { class: "row__body" }, h("span", { class: "row__title" }, col.name), h("span", { class: `row__meta${cost ? " acct-used__cost" : ""}` }, cost ?? scheduleText(col))),
          ];
          if (!ctx.openCollection) return h("div", { class: "row acct-used" }, ...inner, h("span", {}));
          const b = h("button", { class: "row acct-used", type: "button" }, ...inner, trail());
          b.addEventListener("click", () => ctx.openCollection!(col.id));
          return b;
        })
      )
    );
  }

  /** YouTube only: its API has no watch history, so it comes from a Google Takeout file. */
  /** Spotify signed in before Music's playlist scopes: one quiet line and the sign-in, filled in once the playlists are read (never an error). */
  function playlistsGroup(): HTMLElement {
    const slot = h("div", {});
    void import("../db/music").then(({ loadPlaylists }) =>
      loadPlaylists().then((v) => {
        if (!v.needs_sign_in) return;
        const b = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Sign in again");
        b.addEventListener("click", () => signIn().catch((err) => showToast(errorText(err, "Couldn't start sign-in"), { icon: "close", timeoutMs: 6000 })));
        slot.replaceWith(group("Playlists", h("div", { class: "card acct-note" }, h("p", { class: "acct-note__text" }, "Sign in again to let Athena read your playlists."), b)));
      }, () => undefined)
    );
    return slot;
  }

  function historyGroup(): HTMLElement {
    const b = h("button", { class: "btn btn--soft btn--sm acct-history__btn", type: "button", "aria-label": "Import watch history" }, "Import");
    b.addEventListener("click", () => void import("./youtube-import").then((m) => m.openYouTubeImport(c, () => void ctx.reload())));
    return group(
      "Watch history",
      h(
        "div",
        { class: "card card--flush list" },
        importRow(icons.clock(), b, "/watch-history", ["video", "videos"], "From a Google Takeout file", "YouTube doesn't share it, so it comes from a file")
      )
    );
  }

  /** Goodreads only: finish dates aren't on its public shelves, but they are in its Export library file. */
  function libraryGroup(): HTMLElement {
    const b = h("button", { class: "btn btn--soft btn--sm acct-history__btn", type: "button", "aria-label": "Import your library" }, "Import");
    b.addEventListener("click", () => void import("./goodreads-import").then((m) => m.openGoodreadsImport(c, () => void ctx.reload())));
    return group(
      "Reading history",
      h("div", { class: "card card--flush list" }, importRow(icons.book(), b, "/library", ["book", "books"], "From your Goodreads export", "Puts each book on the day you finished it"))
    );
  }

  /** Netflix only: no API for what you watched, but Viewing activity downloads it, one file per profile. */
  function viewingGroup(): HTMLElement {
    const b = h("button", { class: "btn btn--soft btn--sm acct-history__btn", type: "button", "aria-label": "Import your viewing history" }, "Import");
    b.addEventListener("click", () => void import("./netflix-import").then((m) => m.openNetflixImport(c, () => void ctx.reload())));
    return group(
      "Viewing history",
      h(
        "div",
        { class: "card card--flush list" },
        importRow(icons.tv(), b, "/viewing", ["episode or film", "episodes and films"], "Import your viewing history", "From a file Netflix lets you download", "Add a newer file or another profile")
      )
    );
  }

  /** Swarm only: the days without a check-in come from a Google Maps Timeline file (components/timeline-import.ts). */
  function timelineGroup(): HTMLElement {
    const b = h("button", { class: "btn btn--soft btn--sm acct-history__btn", type: "button", "aria-label": "Import your Timeline" }, "Import");
    b.addEventListener("click", () => void import("./timeline-import").then((m) => m.openTimelineImport(() => void ctx.reload())));
    return group(
      "Everywhere else",
      h("div", { class: "card card--flush list" }, h("div", { class: "row acct-used" }, h("span", { class: "tile tile--sm" }, icons.pin()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, "Google Maps Timeline"), h("span", { class: "row__meta" }, "Fills in the places you didn't check in")), b))
    );
  }

  /** "Imported 7 November · 39,251 videos": this device's copy first, then the server's (the same on every device). */
  function importRow(icon: SVGElement, button: HTMLElement, path: string, unit: [string, string], idle: string, idleMeta: string, again = "Import a newer export to add what's new"): HTMLElement {
    const title = h("span", { class: "row__title" });
    const meta = h("span", { class: "row__meta" });
    const paint = (t: ImportLine | null) => {
      title.textContent = t?.when ?? idle;
      meta.textContent = t ? `${t.count} · ${again}` : idleMeta;
    };
    paint(lastImportTitle(c.id, unit));
    void serverImportTitle(c.id, `/connectors/${encodeURIComponent(c.id)}${path}`, unit).then((t) => t !== undefined && paint(t));
    return h("div", { class: "row acct-used" }, h("span", { class: "tile tile--sm" }, icon), h("span", { class: "row__body" }, title, meta), button);
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `Remove ${c.name}?`,
      body: `Athena deletes its sign-in and stops reading it${usedBy.length ? ` (${usedBy.map((col) => col.name).join(", ")} ${usedBy.length > 1 ? "read" : "reads"} from it)` : ""}. Notes it already saved stay. To cut access completely, also remove Athena in the account's own security settings.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteConnector(c.id);
      showToast(`${c.name} removed`, { icon: "trash" });
      ctx.closed();
      await ctx.reload();
    } catch (err) {
      showToast(errorText(err, "Couldn't remove it"), { icon: "close" });
    }
  }

  // ----- Technical details -----

  const authLabel = c.auth_type === "token" ? "Key" : c.auth_type === "none" ? "None" : cc ? "OAuth · client credentials" : c.has_own_client ? "OAuth · your own client" : "OAuth";
  const hostOf = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };
  // Entered by hand (the server doesn't publish its OAuth settings).
  const oauthServer = c.auth_type === "oauth" && c.oauth?.token_endpoint ? hostOf(c.oauth.token_endpoint) : null;
  const hasSettings = c.auth_type === "token" || (c.auth_type === "oauth" && (c.has_own_client || preset.needsOwnClient || c.provider === "custom"));
  const settingsBtn = hasSettings ? h("button", { class: "acct-link", type: "button" }, "Sign-in settings") : null;
  settingsBtn?.addEventListener("click", settings);
  const technical = h(
    "details",
    { class: "form__more acct-fold acct-tech" },
    h("summary", {}, "Technical details"),
    h(
      "div",
      { class: "group" },
      h(
        "div",
        { class: "card card--flush fields" },
        // Gmail, Calendar and Outlook talk to Google or Microsoft itself, so there's no server address worth showing.
        fact("Server", directApi(c) ? `${serviceLabel(c)}, direct` : h("span", { class: "prop__mono", title: c.url }, hostOf(c.url))),
        c.server_info.title || c.server_info.name ? fact("Reports as", [c.server_info.title || c.server_info.name, c.server_info.version ? `v${c.server_info.version}` : ""].filter(Boolean).join(" · ")) : null,
        c.server_info.website_url ? fact("Website", h("a", { class: "prop__link", href: c.server_info.website_url, target: "_blank", rel: "noopener noreferrer" }, hostOf(c.server_info.website_url))) : null,
        // Read from a profile link (Bluesky, Mastodon, Letterboxd…): which profile.
        preset.urlHint && !preset.address?.fields && /^https:\/\//.test(c.url) ? fact("Profile", h("a", { class: "prop__link", href: c.url, target: "_blank", rel: "noopener noreferrer" }, c.url.replace(/^https:\/\/(www\.)?/, "").replace(/\/$/, ""))) : null,
        fact("Sign-in", authLabel),
        oauthServer ? fact("OAuth server", h("span", { class: "prop__mono", title: c.oauth.token_endpoint }, oauthServer)) : null,
        c.oauth?.audience ? fact("Audience", h("span", { class: "prop__mono" }, c.oauth.audience)) : null,
        c.scope ? fact("Scope", h("span", { class: "prop__mono" }, c.scope.replace(/https:\/\/www\.googleapis\.com\/auth\//g, ""))) : null,
        fact("Added", relativeTime(c.created_at)),
        c.tools_checked_at ? fact("Last checked", relativeTime(c.tools_checked_at)) : null,
        c.status_detail && problem ? fact("Last message", h("span", { class: "prop__mono" }, c.status_detail)) : null
      ),
      settingsBtn ? h("div", { class: "acct-fold__row" }, settingsBtn) : null
    )
  );

  // ----- Footer: quiet, with Remove last -----

  const footBtn = (label: string, run: () => void | Promise<void>, danger = false) => {
    const b = h("button", { class: `acct-foot__btn${danger ? " acct-foot__btn--danger" : ""}`, type: "button" }, label) as HTMLButtonElement;
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await run();
      } finally {
        b.disabled = false;
      }
    });
    return b;
  };
  const foot = h(
    "nav",
    { class: "acct-foot", "aria-label": "Account actions" },
    footBtn("Rename", () => openRenameAccount(c, () => void ctx.reload())),
    // With a problem, its box holds the one way forward (sign in, or Check now when the server's down).
    importOnly || problem ? null : footBtn("Check connection", async () => {
      await checkTools(c);
      await ctx.reload();
    }),
    !problem && c.auth_type === "oauth" && !cc ? footBtn("Sign in again", () => signIn().catch((err) => showToast(errorText(err, "Couldn't start sign-in"), { icon: "close", timeoutMs: 6000 }))) : null,
    footBtn("Remove", remove, true)
  );

  const label = c.account_label.trim();
  const el = h(
    "div",
    { class: "note profile conn-detail acct-detail" },
    h(
      "header",
      { class: "profile__hero conn-hero" },
      connectorLogo(c, "lg"),
      h("h2", { class: "page-title profile__name" }, c.name),
      h("p", { class: "profile__sub" }, [serviceLabel(c), label.toLowerCase()].filter(Boolean).join(" · ")),
      problem || importOnly ? null : statusLine("good", workingText(c)),
      c.provider === "custom" && c.server_info.description ? h("p", { class: "conn-hero__about" }, c.server_info.description) : null
    ),
    problem ? problemBox(problem) : null,
    importOnly ? null : usedByGroup(),
    PICKS_CALENDARS.has(c.provider) && directApi(c) && !problem ? calendarsGroup(c, { onSaved: () => void ctx.reload() }) : null,
    ((c.provider === "gmail" || c.provider === "outlook-mail") && c.auth_type === "oauth" || (c.provider === "fastmail" && c.auth_type === "token")) && !problem ? mailRulesGroup(c.provider, accountMailPort(c)) : null,
    // History loaded when it was connected (components/history-load.ts), and "Load history again".
    loadsHistory(c.provider) && !problem ? group("Your history", h("div", { class: "card card--flush list" }, historyRow(c, { again: true }))) : null,
    c.provider === "youtube" ? historyGroup() : null,
    c.provider === "goodreads" ? libraryGroup() : null,
    c.provider === "netflix" ? viewingGroup() : null,
    c.provider === "swarm" ? timelineGroup() : null,
    c.provider === "spotify" && !problem ? playlistsGroup() : null,
    // A live source (OpenSky, Google Maps routes, TfL, National Rail: lib/presets/flights.ts, live-travel.ts) has no tools: say what it's for.
    importOnly ? null : preset.live ? (problem ? null : liveUse(preset.live)) : permissions,
    custom ? sharingGroup() : null,
    DRAFT_SCOPE[c.provider] && (c.auth_type === "oauth" || c.provider === "fastmail") ? draftsGroup() : null,
    RSVP_SCOPE[c.provider] && directApi(c) && (c.auth_type === "oauth" || (c.provider === "icloud-calendar" && !problem)) ? invitesGroup() : null,
    (MOVE_PROVIDERS as readonly string[]).includes(c.provider) && directApi(c) && (c.auth_type === "oauth" || (c.provider === "icloud-calendar" && !problem)) ? movingGroup() : null,
    // Notion: "Let Athena create pages" under a page the owner picks (components/notion-write.ts).
    c.provider === "notion" && !problem ? notionWriteGroup(c.id, group) : null,
    // DVLA and DVSA MOT history: the cars Athena looks up (components/car-vehicles.ts).
    (c.provider === "dvla" || c.provider === "dvsa-mot") && !problem ? carVehiclesGroup(group) : null,
    importOnly ? null : technical,
    foot,
    h("p", { class: "conn-foot" }, icons.shield(), importOnly ? "Athena reads your files on this device. Only titles and dates leave it." : preset.live && c.auth_type === "token" ? "Your key is kept encrypted on Athena's server. This device never holds it." : c.auth_type === "none" ? "There's no sign-in. Athena keeps only your profile link." : "Your sign-in is kept encrypted on Athena's server. This device never holds it.")
  );
  if (c.tools.length) paintAll();
  return { el, id: c.id, destroy: () => undefined };
}

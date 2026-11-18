/**
 * "Emails Athena reads": the owner's rules for one Gmail or Outlook account
 * (lib/mail-rules.ts). The inbox switch comes first, as it covers the usual
 * case: mail a filter archives never reaches Athena. Then a live count of
 * what the rules would skip over the last 24 hours, the busiest senders as
 * one-tap suggestions, and lists of senders, subjects and labels.
 *
 * Every change saves on its own. The server applies the rules in the mail
 * adapters, so a rule can't be missed by Ask, a collection or MCP; this page
 * only edits them. The preview is counts and senders only: no email is read.
 *
 * Built only with h() and text nodes. The data comes through a port, so
 * sample mode shows the same page with believable figures.
 */
import "../styles/mail-rules.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { errorText } from "../lib/connectors-ui";
import { getMailLabels, getMailRules, previewMailRules, updateConnector } from "../db/api";
import { NO_RULES, RULE_LIMITS, hasRules, readSender, readSubject, type MailLabel, type MailPreview, type MailRules } from "../../../lib/mail-rules";
import type { Connector } from "../types";

export interface MailRulesPort {
  load(): Promise<{ rules: MailRules; skipped_week: number; unreadable?: boolean }>;
  labels(): Promise<MailLabel[]>;
  preview(rules: MailRules): Promise<MailPreview>;
  save(rules: MailRules): Promise<void>;
}

/** The real account, through /api/connectors/:id/mail. */
export function accountMailPort(c: Pick<Connector, "id">): MailRulesPort {
  return {
    load: () => getMailRules(c.id),
    labels: () => getMailLabels(c.id),
    preview: (rules) => previewMailRules(c.id, rules),
    save: async (rules) => void (await updateConnector(c.id, { mail_rules: rules })),
  };
}

const nf = new Intl.NumberFormat("en-GB");
const count = (n: number, capped = false) => `${nf.format(n)}${capped ? "+" : ""}`;
const emails = (n: number) => (n === 1 ? "email" : "emails");

/** One removable pill. */
function chip(text: string, onRemove: () => void): HTMLElement {
  const x = h("button", { class: "mail-chip__x", type: "button", "aria-label": `Remove ${text}` }, icons.close());
  x.addEventListener("click", onRemove);
  return h("span", { class: "chip mail-chip" }, h("span", { class: "mail-chip__text" }, text), x);
}

export function mailRulesGroup(provider: string, port: MailRulesPort): HTMLElement {
  // Outlook and Fastmail file mail in folders; Gmail labels it.
  const outlook = provider === "outlook-mail" || provider === "fastmail";
  const word = outlook ? { one: "folder", many: "folders" } : { one: "label", many: "labels" };
  let rules: MailRules = { ...NO_RULES };
  let labels: MailLabel[] | null = null;
  let labelsFailed = "";

  // ----- the inbox switch -----
  const inboxSw = h("input", { type: "checkbox", role: "switch", class: "switch", "aria-describedby": "mail-inbox-meta" }) as HTMLInputElement;
  const inboxRow = h(
    "label",
    { class: "row tool-row mail-rules__inbox" },
    h("span", { class: "tile tile--sm" }, icons.inbox()),
    h(
      "span",
      { class: "row__body" },
      h("span", { class: "row__title" }, "Only read mail that reaches my inbox"),
      h("span", { class: "row__meta", id: "mail-inbox-meta" }, "Skips mail a filter archives or sends past your inbox. Mail you archive yourself is skipped too, unless you replied.")
    ),
    inboxSw
  );
  inboxSw.addEventListener("change", () => change({ ...rules, inbox_only: inboxSw.checked }));

  // ----- the preview -----
  const previewLine = h("p", { class: "mail-preview__line" });
  const bar = h("span", { class: "mail-preview__fill" });
  const meter = h("div", { class: "mail-preview__bar", "aria-hidden": "true" }, bar);
  const suggestions = h("div", { class: "mail-preview__suggest" });
  const preview = h("div", { class: "card card--sunken mail-preview", "aria-live": "polite", "aria-busy": "true" }, previewLine, meter, suggestions);

  // ----- lists -----
  const status = h("span", { class: "mail-rules__status", "aria-live": "polite" });
  const week = h("p", { class: "mail-rules__week", hidden: true });

  function listRow(o: { title: string; placeholder: string; empty: string; items: () => string[]; add: (raw: string) => string | null; remove: (v: string) => void; label: string }) {
    const chips = h("div", { class: "mail-chips" });
    const input = h("input", { class: "prop__input mail-add__input", type: "text", placeholder: o.placeholder, autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": o.label, enterkeyhint: "done" }) as HTMLInputElement;
    const add = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Add");
    const hint = h("p", { class: "mail-add__hint", hidden: true });
    const submit = () => {
      const raw = input.value.trim();
      if (!raw) return;
      const err = o.add(raw);
      if (err) {
        hint.textContent = err;
        hint.hidden = false;
        input.setAttribute("aria-invalid", "true");
        return;
      }
      hint.hidden = true;
      input.removeAttribute("aria-invalid");
      input.value = "";
      input.focus();
    };
    add.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    input.addEventListener("input", () => {
      hint.hidden = true;
      input.removeAttribute("aria-invalid");
    });
    const paint = () => {
      const items = o.items();
      chips.replaceChildren(...(items.length ? items.map((v) => chip(v, () => o.remove(v))) : [h("span", { class: "mail-chips__empty" }, o.empty)]));
    };
    const el = h("div", { class: "mail-list" }, h("p", { class: "mail-list__title" }, o.title), chips, h("div", { class: "mail-add" }, input, add), hint);
    return { el, paint };
  }

  const senders = listRow({
    title: "Skip email from",
    placeholder: "name.com or an address",
    label: "Add a sender or domain to skip",
    empty: "No senders yet",
    items: () => rules.skip_senders,
    add: (raw) => {
      const v = readSender(raw);
      if (!v) return "That isn't an email address or a domain.";
      if (rules.skip_senders.includes(v)) return `${v} is already on the list.`;
      if (rules.skip_senders.length >= RULE_LIMITS.senders) return "That's as many senders as a list can hold.";
      change({ ...rules, skip_senders: [...rules.skip_senders, v] });
      return null;
    },
    remove: (v) => change({ ...rules, skip_senders: rules.skip_senders.filter((s) => s !== v) }),
  });
  const subjects = listRow({
    title: "Skip if the subject contains",
    placeholder: "A word or phrase",
    label: "Add a subject word or phrase to skip",
    empty: "No words yet",
    items: () => rules.skip_subjects,
    add: (raw) => {
      const v = readSubject(raw);
      if (!v) return "Use 2 to 100 characters.";
      if (rules.skip_subjects.some((s) => s.toLowerCase() === v.toLowerCase())) return `“${v}” is already on the list.`;
      if (rules.skip_subjects.length >= RULE_LIMITS.subjects) return "That's as many phrases as a list can hold.";
      change({ ...rules, skip_subjects: [...rules.skip_subjects, v] });
      return null;
    },
    remove: (v) => change({ ...rules, skip_subjects: rules.skip_subjects.filter((s) => s !== v) }),
  });

  /** Toggle chips for the account's labels: pressed means on the list. */
  function labelPicker(key: "skip_labels" | "only_labels", title: string) {
    const box = h("div", { class: "mail-chips mail-labels" });
    const el = h("div", { class: "mail-list" }, h("p", { class: "mail-list__title" }, title), box);
    const other = key === "skip_labels" ? "only_labels" : "skip_labels";
    const paint = () => {
      const chosen = rules[key];
      // Skipping the inbox itself would skip almost everything: it's only offered as a label to read.
      const known = (labels ?? []).filter((l) => key === "only_labels" || l.id !== "INBOX");
      // Chosen labels the account no longer lists stay visible, so they can be removed.
      const all = [...known, ...chosen.filter((l) => !known.some((k) => k.id === l.id))];
      if (!labels && !chosen.length) {
        box.replaceChildren(h("span", { class: "mail-chips__empty" }, labelsFailed || `Finding your ${word.many}…`));
        return;
      }
      if (!all.length) {
        box.replaceChildren(h("span", { class: "mail-chips__empty" }, `No ${word.many} yet`));
        return;
      }
      box.replaceChildren(
        ...all.map((l) => {
          const on = chosen.some((c) => c.id === l.id);
          const b = h("button", { class: "chip mail-label", type: "button", "aria-pressed": String(on) }, on ? icons.check() : null, l.name);
          b.addEventListener("click", () => {
            const next = on ? chosen.filter((c) => c.id !== l.id) : [...chosen, { id: l.id, name: l.name }];
            change({ ...rules, [key]: next, [other]: rules[other].filter((c) => c.id !== l.id) });
          });
          return b;
        })
      );
    };
    return { el, paint };
  }
  const skipLabels = labelPicker("skip_labels", `Skip these ${word.many}`);
  const onlyLabels = labelPicker("only_labels", `Read only these ${word.many}`);
  const only = h(
    "details",
    { class: "form__more mail-rules__only" },
    h("summary", {}, `Only read some ${word.many}`),
    h("div", { class: "mail-rules__only-body" }, h("p", { class: "form__hint" }, `Leave every ${word.one} off to read them all.`), onlyLabels.el)
  );

  const lists = h("div", { class: "card mail-rules__lists" }, senders.el, subjects.el, skipLabels.el);
  const el = h(
    "section",
    { class: "group mail-rules" },
    h("div", { class: "group__head mail-rules__head" }, h("h3", { class: "group__label" }, "Emails Athena reads"), status),
    week,
    h("div", { class: "card card--flush list" }, inboxRow),
    preview,
    lists,
    only,
    h("p", { class: "form__hint" }, "Skipped email never reaches Athena, so it costs nothing. Collections, Ask and Talk all follow these rules.")
  );

  function paint() {
    inboxSw.checked = rules.inbox_only;
    senders.paint();
    subjects.paint();
    skipLabels.paint();
    onlyLabels.paint();
    if (rules.only_labels.length) (only as HTMLDetailsElement).open = true;
  }

  // ----- saving and counting -----

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let saved = rules;
  let seq = 0;

  function change(next: MailRules) {
    rules = next;
    paint();
    status.textContent = "Saving…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), 450);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void count24h(), 700);
  }

  async function save() {
    const sending = rules;
    try {
      await port.save(sending);
      saved = sending;
      if (rules === sending) status.textContent = "Saved";
    } catch (err) {
      rules = saved;
      paint();
      status.textContent = "";
      showToast(errorText(err, "Couldn't save your rules"), { icon: "close", timeoutMs: 6000 });
    }
  }

  function paintPreview(p: MailPreview) {
    const skipped = Math.min(p.skipped, p.total);
    const share = p.total ? skipped / p.total : 0;
    previewLine.replaceChildren(
      ...(p.total === 0
        ? ["No email arrived in the last 24 hours."]
        : !hasRules(rules)
          ? [`${count(p.total, p.capped)} ${emails(p.total)} arrived in the last 24 hours. Athena reads them all.`]
          : ["In the last 24 hours this would skip ", h("strong", {}, count(skipped, p.capped && share > 0.5)), ` of ${count(p.total, p.capped)} ${emails(p.total)}.`])
    );
    meter.hidden = !p.total || !hasRules(rules);
    bar.style.inlineSize = `${Math.round(share * 1000) / 10}%`;
    const fresh = p.suggestions.filter((s) => !rules.skip_senders.includes(s.sender));
    suggestions.replaceChildren(
      ...(fresh.length
        ? [
            h("p", { class: "mail-preview__label" }, "Busiest senders"),
            ...fresh.map((s) => {
              const skip = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": `Skip email from ${s.sender}` }, "Skip");
              skip.addEventListener("click", () => change({ ...rules, skip_senders: [...rules.skip_senders, s.sender] }));
              const where = s.outside_inbox >= s.count ? "None reached your inbox" : s.outside_inbox >= s.count / 2 ? "Most skipped your inbox" : s.outside_inbox === 0 ? "All in your inbox" : "Some skipped your inbox";
              return h(
                "div",
                { class: "mail-suggest" },
                h("span", { class: "mail-suggest__body" }, h("span", { class: "mail-suggest__title" }, `${s.sender} sent ${count(s.count)}`), h("span", { class: "mail-suggest__meta" }, where)),
                skip
              );
            }),
          ]
        : [])
    );
  }

  async function count24h() {
    const mine = ++seq;
    preview.setAttribute("aria-busy", "true");
    preview.classList.add("mail-preview--counting");
    try {
      const p = await port.preview(rules);
      if (mine === seq) paintPreview(p);
    } catch (err) {
      if (mine !== seq) return;
      const retry = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Try again");
      retry.addEventListener("click", () => void count24h());
      meter.hidden = true;
      previewLine.replaceChildren(errorText(err, "Couldn't count your email just now."));
      suggestions.replaceChildren(retry);
    } finally {
      if (mine === seq) {
        preview.setAttribute("aria-busy", "false");
        preview.classList.remove("mail-preview--counting");
      }
    }
  }

  async function start() {
    previewLine.replaceChildren(h("span", { class: "skeleton mail-preview__skel" }));
    meter.hidden = true;
    try {
      const r = await port.load();
      rules = r.rules;
      saved = rules;
      if (r.skipped_week > 0) {
        week.hidden = false;
        week.replaceChildren(icons.shield(), `Skipped ${count(r.skipped_week)} ${emails(r.skipped_week)} this week by your rules.`);
      }
      if (r.unreadable) {
        week.hidden = false;
        week.replaceChildren(icons.shield(), "Your rules are saved, but this server can't read them, so Athena doesn't read this account's email here.");
      }
    } catch (err) {
      status.textContent = "";
      showToast(errorText(err, "Couldn't load your rules"), { icon: "close", timeoutMs: 6000 });
    }
    paint();
    void count24h();
    try {
      labels = await port.labels();
    } catch (err) {
      labelsFailed = errorText(err, `Couldn't load your ${word.many}.`);
    }
    paint();
  }
  void start();
  return el;
}

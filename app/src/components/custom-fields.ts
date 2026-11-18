/**
 * The owner's own fields on a record: one row per field, after the built-in
 * ones in the record's Details card, in the same label-and-value style. Each
 * type edits in place and saves as it changes: text and numbers on change,
 * stars and chips on tap.
 *
 * A saved record shows only the fields that have a value. The empty ones
 * wait behind one quiet row at the end, "Add shoe size and interests", that
 * opens them for editing. A field filled (or cleared) while the record is open
 * stays where it is until the record is closed, so nothing jumps. A record
 * that isn't saved yet shows every field, and saves what's typed with it.
 *
 * Works for any kind (customFieldsSection(kind)), so a new kind of record
 * shows its fields with the same calls: attach() to its Details card (or
 * section() for its own), show(id) for the record, destroy() on close.
 *
 * Built only with h() and text nodes: values can come from agents.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { field as propRow, input, autoTextarea, foldedEditor, pickerInput } from "./fields";
import { showToast } from "./toast";
import { OfflineError } from "../db/records";
import { liveFields, loadAllFields, loadRecordFields, onCustomFieldsChange, setFieldValue, type CustomField, type FieldKind, type FieldValue, type ValueMap } from "../db/custom-fields";
import { addFieldsPrompt, FieldError, linkHref, normaliseValue, placeholderFor, starWords } from "../../../lib/custom-field-rules";

export interface CustomFieldsSection {
  /** Put the rows at the end of a Details card. Call again whenever the card's own rows are rebuilt. */
  attach: (card: HTMLElement) => void;
  /** A "Details" section of its own, for records without a Details card (notes). Hidden while there are no fields. */
  section: () => HTMLElement;
  /**
   * Show this record's fields. null is a record that isn't saved yet: every
   * field shows, and what's typed is kept until the record has an id. Going
   * from null to an id saves it (as commit() does).
   */
  show: (entityId: string | null) => void;
  /** The new record now exists: save what was typed into its fields. For editors that close as soon as they create. */
  commit: (entityId: string) => Promise<void>;
  /**
   * Show a value Athena knows elsewhere in an empty date field whose label
   * matches ("Last visited" from Days), with `note` beside it. Shown, not
   * saved: it's saved only if the owner edits it.
   */
  prefill: (label: RegExp, value: string, note: string) => void;
  destroy: () => void;
}

const CURRENCY = /^[£$€¥₹]$/;
const str = (v: FieldValue | undefined) => (v === undefined || Array.isArray(v) || typeof v === "boolean" ? "" : String(v));

let seq = 0;

export function customFieldsSection(kind: FieldKind): CustomFieldsSection {
  const uid = `cf-${++seq}`;
  let entityId: string | null = null;
  /** The id last shown; undefined before the first show(). */
  let shownFor: string | null | undefined;
  /** Empty fields opened with the "Add …" row or edited while the record is open: they stay showing until it's closed. */
  const revealed = new Set<string>();
  /** Set when the "Add …" row is tapped: the first field it opened gets the caret once drawn. */
  let focusField: string | null = null;
  let fields: CustomField[] = [];
  let values: ValueMap = {};
  let rows: HTMLElement[] = [];
  let host: HTMLElement | null = null;
  let own: HTMLElement | null = null;
  let dead = false;
  let loadSeq = 0;
  /** Our own saves announce a change too: don't reload (and lose the caret) for those. */
  let muted = 0;
  let saving: Promise<void> = Promise.resolve();
  let suggested: { label: RegExp; value: string; note: string } | null = null;
  const suggestionFor = (f: CustomField) => (suggested && f.type === "date" && values[f.id] === undefined && suggested.label.test(f.label) ? suggested : null);

  const current = (id: string) => fields.find((f) => f.id === id)!;

  function complain(error: unknown) {
    const message = error instanceof Error ? error.message : "Couldn't save";
    showToast(message, { icon: error instanceof FieldError ? "pen" : error instanceof OfflineError ? "wifiOff" : "close", timeoutMs: 4000 });
  }

  function save(field: CustomField, raw: unknown, revert: () => void, done?: (value: FieldValue | null) => void) {
    const id = entityId;
    if (!id) {
      // Not saved yet: check it now, keep it, and save it with the record (commit).
      try {
        const { value } = normaliseValue(current(field.id), raw);
        if (value === null) delete values[field.id];
        else values[field.id] = value;
        done?.(value);
      } catch (error) {
        revert();
        complain(error);
      }
      return;
    }
    revealed.add(field.id);
    saving = saving.then(async () => {
      if (dead || !id) return;
      muted++;
      try {
        const saved = await setFieldValue(current(field.id), id, raw);
        fields = fields.map((f) => (f.id === field.id ? saved.field : f));
        if (saved.value === null) delete values[field.id];
        else values[field.id] = saved.value;
        done?.(saved.value);
      } catch (error) {
        revert();
        complain(error);
      } finally {
        muted--;
      }
    });
  }

  /** The record now has an id: save what was typed before it did. Everything showing stays showing. */
  function commit(id: string): Promise<void> {
    if (entityId !== null) return saving;
    entityId = id;
    shownFor = id;
    for (const f of fields) revealed.add(f.id);
    const pending = Object.entries(values);
    saving = saving.then(async () => {
      muted++;
      try {
        for (const [fieldId, value] of pending) {
          const field = fields.find((f) => f.id === fieldId);
          if (!field) continue;
          try {
            const saved = await setFieldValue(field, id, value);
            fields = fields.map((f) => (f.id === fieldId ? saved.field : f));
          } catch (error) {
            complain(error);
          }
        }
      } finally {
        muted--;
      }
    });
    return saving;
  }

  // ---------- one editor per type ----------

  function textRow(f: CustomField): HTMLElement {
    const long = f.type === "long_text";
    const el = long
      ? autoTextarea(str(values[f.id]), { placeholder: placeholderFor(f.label), maxlength: 5000 })
      : input("text", str(values[f.id]), { placeholder: placeholderFor(f.label), autocomplete: "off", maxlength: 300, enterkeyhint: "done" });
    if (!long) el.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && el.blur());
    el.addEventListener("change", () => {
      const before = str(values[f.id]);
      save(f, el.value, () => (el.value = before), (v) => (el.value = str(v ?? undefined)));
    });
    return propRow(f.label, el);
  }

  function numberRow(f: CustomField): HTMLElement {
    const el = input("text", str(values[f.id]), { placeholder: placeholderFor(f.label), inputmode: "decimal", autocomplete: "off", enterkeyhint: "done" });
    // With a unit, the box is as wide as what's in it, so the unit reads with the number: "6 UK".
    const fit = () => {
      if (f.unit) el.style.width = `calc(${Math.max(1, (el.value || el.placeholder).length)}ch + 21px)`;
    };
    el.addEventListener("input", fit);
    el.addEventListener("keydown", (e) => e.key === "Enter" && el.blur());
    el.addEventListener("change", () => {
      const before = str(values[f.id]);
      save(
        f,
        el.value,
        () => {
          el.value = before;
          fit();
        },
        (v) => {
          el.value = str(v ?? undefined);
          fit();
        }
      );
    });
    fit();
    if (!f.unit) return propRow(f.label, el);
    el.classList.add("prop__input--fit");
    if (!CURRENCY.test(f.unit)) return propRow(f.label, el, h("span", { class: "prop__suffix" }, f.unit));
    // A currency goes before the number, like £45.
    el.id = `${uid}-${f.id}`;
    return h(
      "div",
      { class: "prop" },
      h("label", { class: "prop__label", for: el.id }, f.label),
      h("span", { class: "prop__control prop__control--prefixed" }, h("span", { class: "prop__prefix", "aria-hidden": "true" }, f.unit), el)
    );
  }

  function ratingRow(f: CustomField): HTMLElement {
    // Whole stars by tap or keyboard; a half (from Letterboxd) shows as a half star until changed.
    let value = typeof values[f.id] === "number" ? (values[f.id] as number) : 0;
    const group = h("span", { class: "rating", role: "radiogroup" });
    const stars = [1, 2, 3, 4, 5].map((n) => {
      const b = h("button", { class: "rating__star", type: "button", role: "radio", "aria-label": `${n} ${n === 1 ? "star" : "stars"}` });
      b.addEventListener("click", () => pick(value === n ? 0 : n));
      b.addEventListener("keydown", (e) => {
        const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
        if (!step && e.key !== "Home" && e.key !== "End") return;
        e.preventDefault();
        // From a half, a step lands on the whole star either side of it (4½ → 5 or 4).
        const next = e.key === "Home" ? 1 : e.key === "End" ? 5 : Math.min(5, Math.max(1, step > 0 ? Math.floor(value) + 1 : Math.ceil(value) - 1));
        pick(next);
        stars[next - 1].focus();
      });
      // A pointer that can hover shows what a tap would set.
      b.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && paint(n));
      return b;
    });
    group.addEventListener("pointerleave", () => paint());
    const paint = (preview?: number) => {
      const shown = preview ?? value;
      group.classList.toggle("is-preview", preview !== undefined);
      group.setAttribute("aria-label", value ? `${f.label}: ${starWords(value)}` : f.label);
      stars.forEach((b, i) => {
        const fill = shown >= i + 1 ? "full" : shown >= i + 0.5 ? "half" : "none";
        b.classList.toggle("is-on", fill === "full");
        b.classList.toggle("is-half", fill === "half");
        b.setAttribute("aria-checked", String(i + 1 === value));
        // One stop in the tab order: the chosen star (a half's whole star above it), or the first.
        b.tabIndex = (value ? i + 1 === Math.ceil(value) : i === 0) ? 0 : -1;
        b.replaceChildren(fill === "full" ? icons.starSolid() : fill === "half" ? icons.starHalf() : icons.star());
      });
    };
    function pick(n: number) {
      if (n === value) return;
      const before = value;
      value = n;
      paint();
      stars[n - 1]?.classList.remove("is-set");
      if (n) {
        void stars[n - 1].offsetWidth;
        stars[n - 1].classList.add("is-set");
      }
      save(f, n || null, () => {
        value = before;
        paint();
      });
    }
    group.append(...stars);
    paint();
    group.title = "Tap the same star again to clear it";
    return propRow(f.label, group);
  }

  /** Chips that pick one value (Yes/No, a Choice). Tapping the chosen one clears it. */
  function pickRow(f: CustomField, options: Array<{ label: string; value: FieldValue }>, fold = false): HTMLElement {
    let value: FieldValue | undefined = values[f.id];
    let folded: ReturnType<typeof foldedEditor> | null = null;
    const same = (a: FieldValue | undefined, b: FieldValue) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);
    const chips = options.map((o) => {
      const b = h("button", { class: "chip", type: "button", "aria-pressed": "false" }, o.label);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        const before = value;
        value = same(value, o.value) ? undefined : o.value;
        paint();
        // A pick folds back to the words; clearing it leaves the choices open.
        if (value !== undefined) folded?.fold();
        save(f, value ?? null, () => {
          value = before;
          paint();
          folded?.paint();
        });
      });
      return b;
    });
    const paint = () => chips.forEach((b, i) => b.setAttribute("aria-pressed", String(same(value, options[i].value))));
    paint();
    const row = h("span", { class: "chip-row chip-row--wrap prop__toggles", role: "group", "aria-label": f.label }, ...chips);
    // A saved record shows its choice as words; tapping them brings back the chips.
    if (!fold || !entityId || value === undefined) return propRow(f.label, row);
    folded = foldedEditor(f.label, () => options.find((o) => same(value, o.value))?.label ?? "", row);
    return propRow(f.label, folded.el);
  }

  function choiceRow(f: CustomField): HTMLElement {
    const options = [...f.options];
    const v = values[f.id];
    // A value from before an option was renamed or removed still shows, so it can't vanish unseen.
    if (typeof v === "string" && !options.includes(v)) options.push(v);
    if (!options.length) return propRow(f.label, h("span", { class: "prop__suffix" }, "No options yet. Add some in Settings."));
    return pickRow(
      f,
      options.map((o) => ({ label: o, value: o })),
      true
    );
  }

  function dateRow(f: CustomField): HTMLElement {
    const hint = suggestionFor(f);
    const picker = pickerInput("date", str(values[f.id]) || (hint?.value ?? ""), { "aria-label": f.label });
    const el = picker.input;
    const note = hint ? h("span", { class: "prop__suffix" }, hint.note) : null;
    el.addEventListener("change", () => {
      const before = str(values[f.id]);
      note?.remove();
      save(f, el.value || null, () => {
        el.value = before;
        picker.paint();
      });
    });
    return propRow(f.label, picker.el, note);
  }

  function linkRow(f: CustomField): HTMLElement {
    const el = input("url", str(values[f.id]), { placeholder: placeholderFor(f.label), autocomplete: "off", inputmode: "url", enterkeyhint: "done" });
    const open = h("a", { class: "icon-btn icon-btn--sm icon-btn--ghost", target: "_blank", rel: "noopener noreferrer", "aria-label": `Open ${f.label}` }, icons.link());
    const paintOpen = () => {
      const href = linkHref(el.value);
      open.hidden = !href;
      if (href) open.setAttribute("href", href);
    };
    el.addEventListener("input", paintOpen);
    el.addEventListener("keydown", (e) => e.key === "Enter" && el.blur());
    el.addEventListener("change", () => {
      const before = str(values[f.id]);
      save(
        f,
        el.value,
        () => {
          el.value = before;
          paintOpen();
        },
        (v) => {
          el.value = str(v ?? undefined);
          paintOpen();
        }
      );
    });
    paintOpen();
    return propRow(f.label, el, open);
  }

  /** Several values as removable tags, with a box to type a new one and the unused options to tap. */
  function choicesRow(f: CustomField): HTMLElement {
    let chosen = Array.isArray(values[f.id]) ? [...(values[f.id] as string[])] : [];
    const box = h("input", {
      class: "tag-input choice-tags__input",
      type: "text",
      placeholder: placeholderFor(f.label),
      "aria-label": `Add to ${f.label}`,
      autocomplete: "off",
      autocapitalize: "sentences",
      enterkeyhint: "done",
      maxlength: 60,
    }) as HTMLInputElement;
    const listId = `${uid}-${f.id}-suggest`;
    box.setAttribute("aria-controls", listId);
    const tags = h("span", { class: "choice-tags" });
    const suggest = h("span", { class: "choice-suggest", id: listId, role: "group", "aria-label": `Suggestions for ${f.label}`, hidden: true });

    const commit = (next: string[]) => {
      const before = chosen;
      chosen = next;
      paint();
      save(
        f,
        next,
        () => {
          chosen = before;
          paint();
        },
        (v) => {
          chosen = Array.isArray(v) ? v : [];
          paint();
        }
      );
    };
    const add = (text: string) => {
      const t = text.trim().replace(/,$/, "").trim();
      box.value = "";
      if (!t || chosen.some((c) => c.toLowerCase() === t.toLowerCase())) return paintSuggest();
      commit([...chosen, t]);
    };
    function paintSuggest() {
      const typed = box.value.trim().toLowerCase();
      const unused = current(f.id).options.filter((o) => !chosen.some((c) => c.toLowerCase() === o.toLowerCase()) && (!typed || o.toLowerCase().includes(typed)));
      suggest.replaceChildren(
        ...unused.slice(0, 12).map((o) => {
          const b = h("button", { class: "chip chip--sm choice-suggest__item", type: "button" }, icons.plus(), o);
          // Keep the box focused (and the keyboard up) while tapping a suggestion.
          b.addEventListener("pointerdown", (e) => e.preventDefault());
          b.addEventListener("click", () => {
            add(o);
            box.focus();
          });
          return b;
        })
      );
      suggest.hidden = !(document.activeElement === box && unused.length);
    }
    function paint() {
      tags.replaceChildren(
        ...chosen.map((t) => {
          const x = h("button", { class: "tag__remove", type: "button", "aria-label": `Remove ${t}` }, icons.close());
          x.addEventListener("click", () => commit(chosen.filter((c) => c !== t)));
          return h("span", { class: "tag tag--editable" }, t, x);
        }),
        box
      );
      paintSuggest();
    }
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        add(box.value);
      } else if (e.key === "Backspace" && !box.value && chosen.length) {
        commit(chosen.slice(0, -1));
      } else if (e.key === "Escape" && !suggest.hidden) {
        e.stopPropagation();
        suggest.hidden = true;
      }
    });
    box.addEventListener("input", paintSuggest);
    box.addEventListener("focus", paintSuggest);
    box.addEventListener("blur", () => {
      if (box.value.trim()) add(box.value);
      setTimeout(paintSuggest, 0);
    });
    paint();
    const row = h(
      "div",
      { class: "prop prop--tags", role: "group", "aria-label": f.label },
      h("span", { class: "prop__label" }, f.label),
      h("span", { class: "prop__control choice-tags__control" }, tags, suggest)
    );
    // Tapping the empty space in the row puts the caret in the box.
    row.addEventListener("click", (e) => e.target === row.lastElementChild && box.focus());
    return row;
  }

  function rowFor(f: CustomField): HTMLElement {
    switch (f.type) {
      case "text":
      case "long_text":
        return textRow(f);
      case "number":
        return numberRow(f);
      case "rating":
        return ratingRow(f);
      case "boolean":
        return pickRow(f, [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ]);
      case "date":
        return dateRow(f);
      case "link":
        return linkRow(f);
      case "choice":
        return choiceRow(f);
      case "choices":
        return choicesRow(f);
    }
  }

  // ---------- rendering ----------

  /** "Add shoe size and interests": opens the empty fields and puts the caret in the first. */
  function revealRow(hidden: CustomField[]): HTMLElement {
    const b = h(
      "button",
      { class: "prop prop--reveal", type: "button", title: hidden.map((f) => f.label).join(", ") },
      h("span", { class: "prop--reveal__text" }, addFieldsPrompt(hidden.map((f) => f.label)))
    );
    b.addEventListener("click", () => {
      for (const f of hidden) revealed.add(f.id);
      focusField = hidden[0].id;
      render();
    });
    return b;
  }

  function render() {
    for (const r of rows) r.remove();
    // A record being created shows every field; a saved one only those with a value, or opened.
    const shown = entityId ? fields.filter((f) => values[f.id] !== undefined || revealed.has(f.id) || suggestionFor(f)) : fields;
    const hidden = entityId ? fields.filter((f) => !shown.includes(f)) : [];
    rows = shown.map((f) => {
      const row = rowFor(f);
      row.dataset.fieldId = f.id;
      return row;
    });
    if (hidden.length) rows.push(revealRow(hidden));
    host?.append(...rows);
    if (own) own.hidden = !rows.length;
    const target = focusField ? rows.find((r) => r.dataset.fieldId === focusField) : null;
    focusField = null;
    target?.querySelector<HTMLElement>("input, textarea, button")?.focus();
  }

  async function load() {
    const id = entityId;
    const mine = ++loadSeq;
    if (!id) {
      // Not saved yet: every field, and whatever has been typed so far.
      const { fields: all } = await loadAllFields();
      if (dead || mine !== loadSeq || entityId !== null) return;
      fields = liveFields(all, kind);
      render();
      return;
    }
    const loaded = await loadRecordFields(kind, id);
    if (dead || mine !== loadSeq) return;
    fields = loaded.fields;
    values = { ...loaded.values };
    render();
  }

  const unsubscribe = onCustomFieldsChange((k) => {
    if (dead || muted || (k !== null && k !== kind)) return;
    // Don't pull the rows out from under someone typing in one.
    if (rows.some((r) => r.contains(document.activeElement))) return;
    void load();
  });

  return {
    attach(card) {
      host = card;
      card.append(...rows);
    },
    section() {
      if (!own) {
        const card = h("div", { class: "card card--flush fields" });
        own = h("section", { class: "profile__section custom-details", hidden: !rows.length }, h("h2", { class: "group__label" }, "Details"), card);
        host = card;
        card.append(...rows);
      }
      return own;
    },
    show(id) {
      if (id === shownFor) return;
      const before = shownFor;
      if (id !== null && before === null) {
        // Just created: save what was typed, with everything still where it was.
        void commit(id).then(() => {
          if (!dead) void load();
        });
        return;
      }
      // A note swapping its on-device id for the server's is still the same note, still open.
      if (!(id !== null && before?.startsWith("local-"))) {
        revealed.clear();
        values = {};
      }
      if (id !== before) suggested = null;
      entityId = id;
      shownFor = id;
      void load();
    },
    commit,
    prefill(label, value, note) {
      if (suggested?.value === value && suggested.label.source === label.source) return;
      suggested = { label, value, note };
      if (fields.some((f) => suggestionFor(f)) && !rows.some((r) => r.contains(document.activeElement))) render();
    },
    destroy() {
      dead = true;
      unsubscribe();
    },
  };
}

/** Stars to read, not set: a list row's rating (4½ shows a half star). */
export function ratingStars(value: number): HTMLElement {
  const el = h("span", { class: "stars", role: "img", "aria-label": starWords(value) });
  for (let i = 1; i <= 5; i++) {
    const star = value >= i ? icons.starSolid() : value >= i - 0.5 ? icons.starHalf() : icons.star();
    star.classList.add(value >= i ? "is-on" : value >= i - 0.5 ? "is-half" : "is-off");
    el.append(star);
  }
  return el;
}

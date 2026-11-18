/**
 * Adding or changing one of the owner's own fields: its name, its type and,
 * for the types that need them, options or a unit. The same sheet as life
 * admin, reading and goals (components/editor-sheet.ts): a new field is added
 * by its button, an existing one saves each change as it's made, and Archive
 * is in the overflow menu. There's no delete: an archived field keeps its
 * values and can be restored from Archived.
 *
 * A field that already has values can only change to a type that keeps them
 * (lib/custom-field-rules.ts); the others are shown but can't be picked, with
 * a line saying why.
 *
 * Works for any kind: openFieldEditor(kind, field).
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { openEditorSheet } from "./editor-sheet";
import { field as propRow, input } from "./fields";
import { showToast } from "./toast";
import { saveField, setFieldArchived, type CustomField, type FieldKind } from "../db/custom-fields";
import { FIELD_TYPE_ICON } from "../lib/field-meta";
import { relativeTime } from "../lib/format";
import { FIELD_TYPES, FIELD_TYPE_INFO, LIMITS, fieldKindInfo, hasOptions, typeChangeAllowed, type FieldType } from "../../../lib/custom-field-rules";

export function openFieldEditor(kind: FieldKind, initial: CustomField | null): void {
  let rec = initial;
  const info = fieldKindInfo(kind);
  let type: FieldType = initial?.type ?? "text";
  let options = [...(initial?.options ?? [])];
  let unit = initial?.unit ?? "";

  const mark = h("span", { class: "tile tile--sm", "aria-hidden": "true" });
  const paintMark = () => mark.replaceChildren(icons[FIELD_TYPE_ICON[type]]());

  let saving: Promise<void> = Promise.resolve();
  /** An existing field: save this change now; a new one waits for Add. */
  function save(patch: Parameters<typeof saveField>[0], revert?: () => void) {
    if (!rec) return;
    saving = saving.then(async () => {
      if (!rec) return;
      try {
        rec = await saveField(patch, rec.id);
        editor.refresh();
      } catch (error) {
        revert?.();
        showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "pen", timeoutMs: 5000 });
      }
    });
  }

  // ---------- type ----------
  const hasValues = !!initial && initial.value_count > 0;
  const typeHint = h("p", { class: "field-types__hint" });
  const typeButtons = FIELD_TYPES.map((t) => {
    const allowed = !initial || typeChangeAllowed(initial.type, t, hasValues);
    const b = h(
      "button",
      { class: "field-type", type: "button", role: "radio", "aria-checked": "false", "aria-disabled": allowed ? undefined : "true" },
      h("span", { class: "field-type__icon", "aria-hidden": "true" }, icons[FIELD_TYPE_ICON[t]]()),
      h("span", { class: "field-type__label" }, FIELD_TYPE_INFO[t].label),
      h("span", { class: "field-type__hint" }, FIELD_TYPE_INFO[t].hint)
    );
    b.addEventListener("click", () => {
      if (t === type) return;
      if (!allowed) {
        typeHint.classList.add("is-flash");
        setTimeout(() => typeHint.classList.remove("is-flash"), 600);
        return;
      }
      const before = type;
      type = t;
      paintType();
      save({ type: t, ...(hasOptions(t) ? { options } : {}), ...(t === "number" ? { unit } : {}) }, () => {
        type = before;
        paintType();
      });
    });
    return b;
  });
  const typeGroup = h("div", { class: "field-types", role: "radiogroup", "aria-label": "What it holds" }, ...typeButtons);
  if (hasValues) {
    const n = initial!.value_count;
    const things = n === 1 ? info.one : info.one === "person" ? "people" : `${info.one}s`;
    typeHint.textContent = `It's filled in for ${n} ${things}, so it can only change to something that keeps what's there. For anything else, add a new field.`;
  }

  // ---------- options (choice, choices) ----------
  const optionsCard = h("div", { class: "card card--flush fields field-options" });
  const optionsHint = h("p", { class: "field-types__hint" });
  const optionsSection = h("section", { class: "profile__section" }, h("h2", { class: "group__label" }, "Options"), optionsCard, optionsHint);
  const newOption = input("text", "", { placeholder: "Add an option", autocomplete: "off", enterkeyhint: "done", maxlength: LIMITS.option, "aria-label": "Add an option" });

  function setOptions(next: string[], renames?: Array<{ from: string; to: string }>) {
    const before = options;
    options = next;
    paintOptions();
    save({ options: next, ...(renames ? { renames } : {}) }, () => {
      options = before;
      paintOptions();
    });
  }
  function addOption() {
    const v = newOption.value.trim().replace(/\s+/g, " ");
    newOption.value = "";
    if (!v || options.some((o) => o.toLowerCase() === v.toLowerCase())) return;
    setOptions([...options, v]);
    requestAnimationFrame(() => newOption.focus());
  }
  newOption.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    addOption();
  });
  newOption.addEventListener("change", () => newOption.value.trim() && addOption());

  function paintOptions() {
    optionsSection.hidden = !hasOptions(type);
    optionsHint.textContent =
      type === "choices" ? "New ones are added as you use them, too." : options.length ? "" : "Add the choices to pick from.";
    optionsHint.hidden = !optionsHint.textContent;
    optionsCard.replaceChildren(
      ...options.map((o, i) => {
        const edit = input("text", o, { autocomplete: "off", maxlength: LIMITS.option, "aria-label": `Option ${i + 1}` });
        edit.addEventListener("keydown", (e) => e.key === "Enter" && edit.blur());
        edit.addEventListener("change", () => {
          const v = edit.value.trim().replace(/\s+/g, " ");
          if (!v) return void (edit.value = o);
          if (v === o) return;
          if (options.some((x, j) => j !== i && x.toLowerCase() === v.toLowerCase())) {
            edit.value = o;
            return void showToast(`“${v}” is already an option`, { icon: "pen" });
          }
          setOptions(
            options.map((x, j) => (j === i ? v : x)),
            [{ from: o, to: v }]
          );
        });
        const remove = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost field-option__remove", type: "button", "aria-label": `Remove ${o}` }, icons.close());
        remove.addEventListener("click", () => setOptions(options.filter((_, j) => j !== i)));
        return h("div", { class: "prop prop--option" }, h("span", { class: "prop__control" }, edit, remove));
      }),
      h("div", { class: "prop prop--option prop--new-option" }, h("span", { class: "prop__control" }, newOption))
    );
  }

  // ---------- unit (number) ----------
  const unitInput = input("text", unit, { placeholder: "Optional, like UK or cm", autocomplete: "off", maxlength: LIMITS.unit, enterkeyhint: "done" });
  unitInput.addEventListener("keydown", (e) => e.key === "Enter" && unitInput.blur());
  unitInput.addEventListener("change", () => {
    const before = unit;
    unit = unitInput.value.trim();
    save({ unit }, () => {
      unit = before;
      unitInput.value = before;
    });
  });
  const unitSection = h("div", { class: "card card--flush fields" }, propRow("Unit", unitInput));

  function paintType() {
    typeButtons.forEach((b, i) => b.setAttribute("aria-checked", String(FIELD_TYPES[i] === type)));
    unitSection.hidden = type !== "number";
    paintOptions();
    paintMark();
  }

  const typeSection = h("section", { class: "profile__section" }, h("h2", { class: "group__label" }, "What it holds"), typeGroup, typeHint);
  typeHint.hidden = !typeHint.textContent;
  paintType();

  const editor = openEditorSheet({
    newLabel: `New field for ${info.many}`,
    isNew: !initial,
    titleValue: initial?.label ?? "",
    placeholder: "Name, like Shoe size",
    mark,
    createLabel: "Add field",
    sections: [
      typeSection,
      unitSection,
      optionsSection,
      h("p", { class: "sheet-hint field-editor__privacy" }, icons.shield(), "Keep bank, card, password and medical details out of fields."),
    ],
    onTitle: (label) => {
      const before = rec?.label ?? "";
      save({ label }, () => (editor.title.value = before));
    },
    create: async () => {
      if (newOption.value.trim()) addOption();
      await saveField({ kind, label: editor.title.value, type, options: hasOptions(type) ? options : [], unit: type === "number" ? unit : "" });
      showToast(`Added ${editor.title.value.trim()} to ${info.many}`, { icon: "check" });
      return true;
    },
    status: () => (rec ? `On ${info.many} · added ${relativeTime(rec.created_at)}` : ""),
    archive: async () => {
      if (!rec) return;
      const field = await setFieldArchived(rec, true);
      showToast(`${field.label} archived, values kept`, {
        icon: "archive",
        action: { label: "Undo", run: () => void setFieldArchived(field, false).catch((e) => showToast(e instanceof Error ? e.message : "Couldn't restore it", { icon: "close" })) },
      });
    },
  });
  editor.sheet.dialog.classList.add("field-editor");
}

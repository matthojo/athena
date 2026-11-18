/**
 * Settings → Ask → Skills (#/settings/skills, #/settings/skills/<id>,
 * #/settings/skills/new): the owner's skills (lib/skills.ts), each with its
 * switch, when it was last used and where it came from; the editor (Name,
 * Use when, Instructions, files); and the ways in: upload a SKILL.md, a zip
 * or a folder, import from a link, or write one. Every import shows its whole
 * text and files before anything is saved. A draft from a chat ("Make this a
 * skill" in Ask) opens here and is only saved when the owner taps Save.
 *
 * A Team assistant's own skill (docs/team.md, "Skills") is listed under Team,
 * tagged with the assistant's avatar and name, with no switch: only that
 * assistant uses it, and main Ask never does.
 */
import "../styles/skills.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet, type SheetHandle } from "./sheet";
import { confirmDialog } from "./confirm";
import { showToast } from "./toast";
import { relativeTime, shortDate } from "../lib/format";
import { deleteSkill, downloadSkill, fetchSkill, fetchSkills, holdSkillDraft, onSkillsChange, previewLink, previewUpload, saveSkill, setSkillEnabled, takeSkillDraft, type AppSkill, type SkillDraftInput } from "../db/skills";
import { descriptionProblem, nameProblem, SKILL_LIMITS, slugName, skillTitle, type SkillPreview, type SkillSource } from "../../../lib/skills";
import { isSampleMode } from "../db/api";
import { listTeam, type TeamAssistant } from "../db/team";
import { renderAvatarTile } from "../team/avatar";

type Nav = { open: (id: string | null) => void };

const errorText = (error: unknown) => (error instanceof Error && error.message && !/fetch|network|Failed/i.test(error.message) ? error.message : "That didn't work. Check you're online.");

/** "From github.com/acme/skills", "Uploaded from prep.zip", "Comes with Athena". */
export function sourceWords(s: SkillSource): string {
  if (s.kind === "starter") return "Comes with Athena";
  if (s.kind === "chat") return "Drafted from a conversation";
  if (s.kind === "team") return "Written by Athena at setup";
  if (s.kind === "written") return "Written in Athena";
  if (s.kind === "link" && s.url) {
    try {
      const u = new URL(s.url);
      const parts = u.pathname.split("/").filter(Boolean);
      return `From ${u.hostname.replace(/^www\./, "")}${parts.length ? `/${parts.slice(0, 2).join("/")}` : ""}`;
    } catch {
      return "From a link";
    }
  }
  return s.file ? `Uploaded from ${s.file}` : "Uploaded";
}

const usedWords = (s: AppSkill) => (s.last_used_at ? `Used ${relativeTime(s.last_used_at)}` : "Not used yet");
const size = (text: string) => {
  const n = new TextEncoder().encode(text).byteLength;
  return n < 1024 ? `${n} bytes` : `${Math.round(n / 102.4) / 10} KB`;
};

// ---------- the list ----------

/** The tag on an assistant's own skill: its avatar and name. */
function assistantTag(a: Pick<TeamAssistant, "name" | "avatar"> | undefined): HTMLElement {
  return h("span", { class: "skill-tag" }, a ? renderAvatarTile(a.avatar, { size: 20, animate: false }) : null, h("span", {}, a ? a.name : "An assistant"));
}

/** An assistant's own skill: tagged with it, and no switch (only it uses the skill). */
function teamRow(s: AppSkill, who: TeamAssistant | undefined, nav: Nav): HTMLElement {
  const name = who?.name ?? "its assistant";
  const open = h(
    "button",
    { class: "row skill-row__open", type: "button", "aria-label": `${s.title}, ${name}'s skill. Edit` },
    h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons.book()),
    h("span", { class: "row__body" }, h("span", { class: "row__title" }, s.title), h("span", { class: "row__meta skill-row__desc" }, s.team?.summary || s.description), h("span", { class: "row__meta" }, `Only ${name} uses it`))
  );
  open.addEventListener("click", () => nav.open(s.id));
  return h("div", { class: "skill-row skill-row--team", "data-id": s.id }, open, h("span", { class: "skill-row__switch" }, assistantTag(who)));
}

function skillRow(s: AppSkill, nav: Nav, refresh: () => void): HTMLElement {
  const sw = h("input", { type: "checkbox", role: "switch", class: "switch", checked: s.enabled, "aria-label": `${s.title}: on` }) as HTMLInputElement;
  sw.addEventListener("click", (e) => e.stopPropagation());
  sw.addEventListener("change", async () => {
    sw.disabled = true;
    try {
      await setSkillEnabled(s.id, sw.checked);
      refresh();
    } catch (error) {
      sw.checked = !sw.checked;
      showToast(errorText(error), { icon: "wifiOff" });
    } finally {
      sw.disabled = false;
    }
  });
  const open = h(
    "button",
    { class: "row skill-row__open", type: "button", "aria-label": `${s.title}. ${s.description}. Edit` },
    h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons.book()),
    h(
      "span",
      { class: "row__body" },
      h("span", { class: "row__title" }, s.title),
      h("span", { class: "row__meta skill-row__desc" }, s.description),
      h("span", { class: "row__meta" }, `${usedWords(s)} · ${sourceWords(s.source)}`)
    )
  );
  open.addEventListener("click", () => nav.open(s.id));
  return h("div", { class: `skill-row${s.enabled ? " is-on" : ""}`, "data-id": s.id }, open, h("span", { class: "skill-row__switch" }, sw));
}

/** #/settings/skills */
export function skillsListSection(nav: Nav): { el: HTMLElement; destroy: () => void } {
  const list = h("div", { class: "skills__list" }, h("div", { class: "card card--flush list" }, ...[0, 1, 2].map(() => h("div", { class: "row" }, h("span", { class: "tile tile--sm skeleton" }), h("span", { class: "row__body" }, h("span", { class: "skeleton", style: "height:12px;width:50%" }))))));
  const add = h("button", { class: "btn btn--primary", type: "button" }, icons.plus(), "Add a skill") as HTMLButtonElement;
  add.addEventListener("click", () => openAddSheet(nav, () => void refresh()));
  let max: number = SKILL_LIMITS.skills;

  async function refresh() {
    try {
      const [all, team] = await Promise.all([fetchSkills(), listTeam().catch(() => [] as TeamAssistant[])]);
      const skills = all.filter((s) => !s.assistant_id);
      const theirs = all.filter((s) => s.assistant_id);
      add.disabled = skills.length >= max;
      const teamGroup = theirs.length ? [h("h3", { class: "group__label skills__label" }, "Team"), h("div", { class: "card card--flush list" }, ...theirs.map((s) => teamRow(s, team.find((a) => a.id === s.assistant_id), nav)))] : [];
      if (!skills.length) {
        list.replaceChildren(
          h(
            "div",
            { class: "empty skills__empty" },
            h("span", { class: "tile" }, icons.book()),
            h("p", { class: "empty__title" }, "No skills yet"),
            h("p", { class: "empty__sub" }, "A skill tells Ask how to handle one kind of request, like getting you ready for a meeting. Write one, upload a SKILL.md or a zip, or bring one in from GitHub.")
          ),
          ...teamGroup
        );
        return;
      }
      const on = skills.filter((s) => s.enabled);
      const off = skills.filter((s) => !s.enabled);
      list.replaceChildren(
        ...(on.length ? [h("h3", { class: "group__label skills__label" }, "On"), h("div", { class: "card card--flush list" }, ...on.map((s) => skillRow(s, nav, () => void refresh())))] : []),
        ...(off.length ? [h("h3", { class: "group__label skills__label" }, "Off"), h("div", { class: "card card--flush list" }, ...off.map((s) => skillRow(s, nav, () => void refresh())))] : []),
        ...teamGroup
      );
    } catch {
      list.replaceChildren(h("p", { class: "settings__lede" }, "Skills need a connection."));
    }
  }
  void refresh();
  const unsub = onSkillsChange(() => void refresh());
  max = SKILL_LIMITS.skills;

  return {
    el: h(
      "section",
      { class: "settings__section skills", "aria-labelledby": "settings-skills" },
      h("div", { class: "src-head" }, h("h2", { class: "settings__heading", id: "settings-skills" }, icons.book(), "Skills"), add),
      h("p", { class: "settings__lede" }, "Instructions that change how Ask handles some kinds of request. They use the common SKILL.md format, so a skill moves between Athena and other agents unchanged."),
      list,
      h("p", { class: "skills__rule" }, icons.shield(), h("span", {}, "A skill only changes how Ask goes about a request. It can't send anything, make a change without your Go, or read your transactions while that's off."))
    ),
    destroy: unsub,
  };
}

// ---------- adding: upload, link, write ----------

function openAddSheet(nav: Nav, done: () => void): void {
  const fileInput = h("input", { type: "file", accept: ".md,.zip,text/markdown,application/zip", hidden: true }) as HTMLInputElement;
  const folderInput = h("input", { type: "file", hidden: true, webkitdirectory: "", multiple: true }) as HTMLInputElement;
  const option = (icon: Parameters<typeof iconOf>[0], title: string, detail: string, run: () => void) => {
    const b = h("button", { class: "row", type: "button" }, h("span", { class: "tile tile--sm" }, iconOf(icon)), h("span", { class: "row__body" }, h("span", { class: "row__title" }, title), h("span", { class: "row__meta" }, detail)), h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()));
    b.addEventListener("click", run);
    return b;
  };
  const body = h(
    "div",
    { class: "skills-add" },
    h(
      "div",
      { class: "card card--flush list" },
      option("pen", "Write one", "Name it, say when to use it, and write the steps", () => closeThen(sheet, () => nav.open("new"))),
      option("capture", "Upload a SKILL.md or .zip", "A zip can hold reference files too", () => fileInput.click()),
      option("folder", "Upload a folder", "A folder with SKILL.md in it", () => folderInput.click()),
      option("link", "Import from a link", "A GitHub folder, or a link to a SKILL.md", () => linkStep())
    ),
    fileInput,
    folderInput
  );
  const sheet = openSheet({ title: "Add a skill", label: "Add a skill", body });
  const fromFiles = async (files: File[]) => {
    if (!files.length) return;
    showPreview(sheet, () => previewUpload(files), nav, done);
  };
  fileInput.addEventListener("change", () => void fromFiles([...(fileInput.files ?? [])]));
  folderInput.addEventListener("change", () => void fromFiles([...(folderInput.files ?? [])]));

  function linkStep() {
    const url = h("input", { class: "field", type: "url", inputmode: "url", placeholder: "https://github.com/…/tree/main/my-skill", "aria-label": "Link to the skill", autocomplete: "off", required: true }) as HTMLInputElement;
    const go = h("button", { class: "btn btn--primary btn--block", type: "submit" }, "Preview") as HTMLButtonElement;
    const form = h(
      "form",
      { class: "skills-form" },
      h("label", { class: "skills-form__label" }, h("span", {}, "Link"), url),
      h("p", { class: "form__hint" }, "A public GitHub folder with a SKILL.md in it, or a link straight to a SKILL.md. Athena reads it once and shows you everything before saving."),
      go
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!url.value.trim()) return url.focus();
      showPreview(sheet, () => previewLink(url.value.trim()), nav, done);
    });
    sheet.setTitle("Import from a link");
    sheet.setBack(() => {
      sheet.setTitle("Add a skill");
      sheet.setBack(null);
      setBody(sheet, body);
    });
    setBody(sheet, form);
    url.focus();
  }
}

const iconOf = (name: "pen" | "capture" | "folder" | "link") => icons[name]();

/** Close the sheet, then go: its history entry is taken back first, so the new page isn't. */
function closeThen(sheet: SheetHandle, go: () => void): void {
  sheet.close();
  setTimeout(go, 450);
}

function setBody(sheet: SheetHandle, el: HTMLElement): void {
  sheet.dialog.querySelector(".sheet__scroll")?.replaceChildren(el);
}

/** The whole text and every file, before anything is saved. */
export function previewEl(p: SkillPreview): HTMLElement {
  const files = p.files.map((f) => {
    const d = h("details", { class: "skill-file" }, h("summary", {}, icons.note(), h("span", { class: "skill-file__name" }, f.path), h("span", { class: "skill-file__size" }, size(f.text))), h("pre", { class: "skill-pre" }, f.text));
    return d;
  });
  return h(
    "div",
    { class: "skill-preview" },
    h("p", { class: "skill-preview__source" }, icons.link(), sourceWords(p.source)),
    h("dl", { class: "skill-preview__meta" }, h("dt", {}, "Name"), h("dd", {}, p.name), h("dt", {}, "Use when"), h("dd", {}, p.description)),
    h("p", { class: "skills-form__caption" }, "Instructions"),
    h("pre", { class: "skill-pre skill-pre--body" }, p.body),
    p.files.length ? h("p", { class: "skills-form__caption" }, p.files.length === 1 ? "1 file" : `${p.files.length} files`) : null,
    ...files,
    p.skipped.length
      ? h("ul", { class: "skill-skipped", "aria-label": "Not used" }, ...p.skipped.map((s) => h("li", {}, h("span", { class: "skill-file__name" }, s.path), h("span", { class: "skill-skipped__why" }, s.reason))))
      : null
  );
}

function showPreview(sheet: SheetHandle, load: () => Promise<SkillPreview>, nav: Nav, done: () => void): void {
  sheet.setTitle("Check it before saving");
  setBody(sheet, h("div", { class: "skills-loading" }, h("span", { class: "orb orb--thinking", "aria-hidden": "true" }), h("p", {}, "Reading it…")));
  void load().then(
    (p) => {
      const on = h("input", { type: "checkbox", role: "switch", class: "switch", id: "skill-preview-on", "aria-label": "Switch it on" }) as HTMLInputElement;
      const save = h("button", { class: "btn btn--primary btn--block", type: "button" }, "Save skill") as HTMLButtonElement;
      const edit = h("button", { class: "btn btn--soft btn--block", type: "button" }, "Edit first");
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          const s = await saveSkill({ ...p, source: p.source, enabled: on.checked });
          sheet.close();
          showToast(on.checked ? `${s.title} is saved and on` : `${s.title} is saved. It's off until you switch it on.`, { icon: "check" });
          done();
        } catch (error) {
          save.disabled = false;
          showToast(errorText(error), { icon: "refresh" });
        }
      });
      edit.addEventListener("click", () => {
        holdSkillDraft({ ...p, from: "import" });
        closeThen(sheet, () => nav.open("new"));
      });
      setBody(
        sheet,
        h(
          "div",
          { class: "skills-form" },
          previewEl(p),
          h("label", { class: "skill-switch", for: "skill-preview-on" }, h("span", {}, h("span", { class: "skill-switch__title" }, "Switch it on"), h("span", { class: "row__meta" }, "Ask uses it when a request matches. You can do this later.")), on),
          h("div", { class: "skills-form__actions" }, edit, save)
        )
      );
    },
    (error) => {
      setBody(sheet, h("div", { class: "skills-form" }, h("p", { class: "skills-error" }, icons.flag(), h("span", {}, errorText(error)))));
    }
  );
}

// ---------- the editor ----------

/** #/settings/skills/<id>, or …/new (blank, or a draft from a chat or an import). */
export function skillEditorSection(id: string, nav: Nav & { back: () => void }): { el: HTMLElement; destroy: () => void } {
  const el = h("section", { class: "settings__section skill-editor", "aria-labelledby": "skill-editor-title" }, h("p", { class: "settings__lede" }, "Loading…"));
  const draft = id === "new" ? takeSkillDraft() : null;
  if (id === "new") paint(null, draft);
  else
    void fetchSkill(id).then(async (s) => {
      const who = s?.assistant_id ? (await listTeam().catch(() => [] as TeamAssistant[])).find((a) => a.id === s.assistant_id) : undefined;
      if (s) paint(s, null, who);
      else el.replaceChildren(h("p", { class: "settings__lede" }, "That skill isn't there any more."));
    });

  function paint(was: AppSkill | null, d: (SkillDraftInput & { from: "chat" | "import" }) | null, who?: TeamAssistant) {
    const start = was ?? d;
    const owned = !!was?.assistant_id;
    const ownerName = who?.name ?? "its assistant";
    const name = h("input", { class: "field", type: "text", maxlength: 64, autocapitalize: "off", autocomplete: "off", spellcheck: false, placeholder: "weekly-review", "aria-describedby": "skill-name-hint", value: start?.name ?? "" }) as HTMLInputElement;
    const desc = h("textarea", { class: "field", rows: 3, maxlength: SKILL_LIMITS.description, placeholder: "Use when I ask for a look back at my week.", "aria-describedby": "skill-desc-hint" }, start?.description ?? "") as HTMLTextAreaElement;
    const body = h("textarea", { class: "field skill-editor__body", rows: 12, placeholder: "1. Read this week's days, habits and to-dos.\n2. Say what happened and what slipped.", spellcheck: true }, start?.body ?? "") as HTMLTextAreaElement;
    const nameHint = h("p", { class: "form__hint", id: "skill-name-hint" }, "Lowercase words joined by hyphens, like meeting-prep.");
    const descHint = h("p", { class: "form__hint", id: "skill-desc-hint" });
    const paintDesc = () => (descHint.textContent = `Ask reads this to decide when to use it. ${desc.value.length} of ${SKILL_LIMITS.description}.`);
    paintDesc();
    desc.addEventListener("input", paintDesc);
    name.addEventListener("blur", () => {
      if (name.value && nameProblem(name.value)) name.value = slugName(name.value);
    });
    const on = h("input", { type: "checkbox", role: "switch", class: "switch", id: "skill-on", checked: was?.enabled ?? !!d?.enabled, "aria-label": "On" }) as HTMLInputElement;
    let files = [...(start?.files ?? [])];
    const skipped = start?.skipped ?? [];
    const fileList = h("div", { class: "skill-files" });
    const addFile = h("input", { type: "file", accept: ".md,.txt,.csv,.json", multiple: true, hidden: true }) as HTMLInputElement;
    const addFileBtn = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "Add a file");
    addFileBtn.addEventListener("click", () => addFile.click());
    addFile.addEventListener("change", async () => {
      for (const f of [...(addFile.files ?? [])]) {
        if (!/\.(md|txt|csv|json)$/i.test(f.name)) {
          showToast(`${f.name}: only .md, .txt, .csv and .json files are kept.`, { icon: "flag" });
          continue;
        }
        if (f.size > SKILL_LIMITS.fileBytes) {
          showToast(`${f.name} is over 100 KB.`, { icon: "flag" });
          continue;
        }
        files = [...files.filter((x) => x.path !== f.name), { path: f.name, text: await f.text() }];
      }
      addFile.value = "";
      paintFiles();
    });
    function paintFiles() {
      fileList.replaceChildren(
        ...files.map((f) => {
          const remove = h("button", { class: "icon-btn icon-btn--xs icon-btn--ghost", type: "button", "aria-label": `Remove ${f.path}` }, icons.close());
          remove.addEventListener("click", (e) => {
            e.preventDefault();
            files = files.filter((x) => x !== f);
            paintFiles();
          });
          return h("details", { class: "skill-file" }, h("summary", {}, icons.note(), h("span", { class: "skill-file__name" }, f.path), h("span", { class: "skill-file__size" }, size(f.text)), remove), h("pre", { class: "skill-pre" }, f.text));
        }),
        ...(skipped.length ? [h("ul", { class: "skill-skipped", "aria-label": "Not used" }, ...skipped.map((s) => h("li", {}, h("span", { class: "skill-file__name" }, s.path), h("span", { class: "skill-skipped__why" }, s.reason))))] : []),
        ...(!files.length && !skipped.length ? [h("p", { class: "form__hint" }, "Reference files Ask can read when it uses this skill: .md, .txt, .csv or .json, up to 100 KB each.")] : [])
      );
    }
    paintFiles();

    const save = h("button", { class: "btn btn--primary", type: "submit" }, "Save") as HTMLButtonElement;
    const problem = h("p", { class: "skills-error", hidden: true, role: "alert" });
    const source: Partial<SkillSource> = was?.source ?? (d?.from === "chat" ? { kind: "chat" } : d?.source ?? { kind: "written" });
    const form = h(
      "form",
      { class: "skills-form", novalidate: true },
      d?.from === "chat" ? h("p", { class: "skills-draft-note" }, icons.sparkle(), h("span", {}, "Ask drafted this from your conversation. Nothing is saved until you tap Save, and it stays off until you switch it on.")) : null,
      d?.from === "import" ? h("p", { class: "skills-draft-note" }, icons.link(), h("span", {}, `${sourceWords({ ...(d.source as SkillSource), at: "" })}. Nothing is saved until you tap Save.`)) : null,
      h("label", { class: "skills-form__label" }, h("span", {}, "Name"), name),
      nameHint,
      h("label", { class: "skills-form__label" }, h("span", {}, "Use when"), desc),
      descHint,
      h("label", { class: "skills-form__label" }, h("span", {}, "Instructions"), body),
      h("div", { class: "skills-form__label" }, h("div", { class: "skills-form__row" }, h("span", {}, "Files"), addFileBtn), fileList, addFile),
      owned
        ? h("p", { class: "skill-owned" }, assistantTag(who), h("span", {}, `Only ${ownerName} uses this skill, on every chat and run. Ask never uses it.`))
        : h("label", { class: "skill-switch", for: "skill-on" }, h("span", {}, h("span", { class: "skill-switch__title" }, "On"), h("span", { class: "row__meta" }, "Ask uses it when a request matches what it's for.")), on),
      problem,
      h("div", { class: "skills-form__actions" }, save)
    ) as HTMLFormElement;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const why = nameProblem(name.value.trim()) ?? descriptionProblem(desc.value) ?? (!body.value.trim() ? "Write the instructions: what Ask should do, step by step." : null);
      problem.hidden = !why;
      problem.textContent = why ?? "";
      if (why) return;
      save.disabled = true;
      try {
        const s = await saveSkill({ name: name.value.trim(), description: desc.value, body: body.value, extra: was?.extra ?? d?.extra ?? "", files, skipped, source, ...(owned ? {} : { enabled: on.checked }) }, was?.id);
        showToast(was ? "Saved" : s.enabled ? `${s.title} is saved and on` : `${s.title} is saved. It's off until you switch it on.`, { icon: "check" });
        if (!was) nav.open(s.id);
        else paint(s, null, who);
      } catch (error) {
        save.disabled = false;
        problem.hidden = false;
        problem.textContent = errorText(error);
      }
    });

    const extras: HTMLElement[] = [];
    if (was) {
      const md = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.arrowDown(), "SKILL.md");
      md.addEventListener("click", () => void downloadSkill(was, "md").catch((error) => showToast(errorText(error), { icon: "refresh" })));
      const zip = h("button", { class: "btn btn--soft btn--sm", type: "button", disabled: isSampleMode() && !was.files.length }, icons.arrowDown(), ".zip with files");
      zip.addEventListener("click", () => void downloadSkill(was, "zip").catch((error) => showToast(errorText(error), { icon: "refresh" })));
      const del = h("button", { class: "btn btn--ghost btn--sm skills__delete", type: "button" }, icons.trash(), "Delete");
      del.addEventListener("click", async () => {
        const body = owned ? `${ownerName} goes back to working from its job and instructions. You can give it a new skill from its page.` : "Ask stops using it. Download it first if you might want it back.";
        if (!(await confirmDialog({ title: `Delete ${was.title}?`, body, confirmLabel: "Delete", danger: true }))) return;
        try {
          await deleteSkill(was.id);
          nav.open(null);
        } catch (error) {
          showToast(errorText(error), { icon: "refresh" });
        }
      });
      extras.push(
        h("p", { class: "skill-editor__meta" }, `${sourceWords(was.source)} · added ${shortDate(was.created_at)} · ${was.uses ? `used ${was.uses === 1 ? "once" : `${was.uses} times`}, last ${relativeTime(was.last_used_at!)}` : "not used yet"}`),
        h("div", { class: "skill-editor__downloads" }, h("span", { class: "row__meta" }, "Download"), md, zip, h("span", { class: "skills__spacer" }), del)
      );
    }
    el.replaceChildren(h("div", { class: "src-head" }, h("h2", { class: "settings__heading", id: "skill-editor-title" }, icons.book(), was ? was.title : d ? skillTitle(d.name || "new-skill") : "New skill")), ...extras, form);
    if (!was && !d) name.focus();
  }

  return { el, destroy: () => undefined };
}

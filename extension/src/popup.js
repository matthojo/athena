import { send, setStatus } from "./icons.js";
import { renderOutbox } from "./outbox.js";

const ext = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const status = $("status");
const form = $("note-form");
let saved = null;

$("settings").onclick = () => ext.runtime.openOptionsPage();

async function currentTab() {
  // ?tab= lets the end-to-end test open the popup as a page.
  const asked = new URLSearchParams(location.search).get("tab");
  if (asked) return ext.tabs.get(Number(asked));
  return (await ext.tabs.query({ active: true, currentWindow: true }))[0];
}

function show(result, withNote) {
  if (result.status === "saved" && result.warning) {
    setStatus(status, "warn", result.warning, result.link && { href: result.link, text: "Open in Athena" });
  } else if (result.status === "saved") {
    setStatus(status, "good", withNote ? "Saved, with your note." : "Saved.", { href: result.link, text: "Open in Athena" });
  } else if (result.status === "queued") {
    setStatus(status, "warn", withNote
      ? "Note kept. It goes with the save once Athena answers."
      : "Saved for later. Couldn't reach Athena, so it'll send this when it can.");
  } else if (result.status === "skipped") {
    setStatus(status, "warn", "This page can't be saved. Try it on a regular web page.");
  } else if (result.reason === "setup") {
    setStatus(status, "bad", "Add your Athena address and key first. This save is kept until then.");
    const open = document.createElement("button");
    open.className = "btn btn-outline";
    open.type = "button";
    open.textContent = "Open settings";
    open.onclick = () => ext.runtime.openOptionsPage();
    status.lastChild.append(document.createElement("br"), open);
    open.style.marginTop = "8px";
  } else {
    setStatus(status, "bad", `${result.message || "Something went wrong."} The save is kept here until it goes.`);
  }
}

async function refreshOutbox() {
  const state = await send("state");
  renderOutbox({
    wrap: $("outbox-wrap"),
    list: $("outbox"),
    count: $("outbox-count"),
    jobs: state.queue.filter((j) => j.id !== saved?.id),
    onChange: refreshOutbox,
  });
}

$("retry-all").onclick = async () => {
  await send("retry");
  refreshOutbox();
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const note = $("note").value.trim();
  if (!note || !saved) return;
  $("note-save").disabled = true;
  setStatus(status, "busy", "Adding your note…");
  const result = await send("note", { id: saved.id, note });
  show({ ...result, link: result.link || saved.link }, true);
  if (result.status === "saved" || result.status === "queued") form.hidden = true;
  else $("note-save").disabled = false;
  refreshOutbox();
});

$("note").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) form.requestSubmit();
});
if (/Mac|iPhone|iPad/.test(navigator.platform)) $("note-hint").textContent = "⌘ Enter adds it";

async function main() {
  const tab = await currentTab();
  $("page-title").textContent = tab?.title || tab?.url || "This tab";
  try {
    $("page-host").textContent = new URL(tab.url).host;
  } catch {
    $("page-host").textContent = "";
  }
  setStatus(status, "busy", "Saving…");
  saved = await send("save-page", { tab: { id: tab?.id, url: tab?.url, title: tab?.title } });
  show(saved);
  form.hidden = !(saved.status === "saved" || saved.status === "queued");
  if (!form.hidden) $("note").focus();
  refreshOutbox();
}

main();

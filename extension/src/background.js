// Background: context menus, the shortcut, the outbox and its retries.
// Talks to one host only: the Athena address the owner set.

import { ext } from "./lib/ext.js";
import { createQueue } from "./lib/queue.js";
import { imageJob, isPublicUrl, isSavablePage, linkJob, MAX_IMAGE_BYTES, pageJob, selectionJob } from "./lib/capture.js";
import { readImage, readSelection, showToast } from "./lib/page.js";
import { buildTestRequest, send } from "./lib/api.js";
import { validateSettings } from "./lib/settings.js";

const ALARM = "athena-retry";

async function getSettings() {
  const { settings } = await ext.storage.local.get("settings");
  return settings || null;
}

const queue = createQueue({
  fetch: (...args) => fetch(...args),
  getSettings,
  store: {
    load: async () => (await ext.storage.local.get("outbox")).outbox,
    save: (outbox) => ext.storage.local.set({ outbox }),
  },
});

// ---------- Menus and shortcut ----------

const MENUS = [
  { id: "save-page", title: "Save page", contexts: ["page"] },
  { id: "save-selection", title: "Save selection as a quote", contexts: ["selection"] },
  { id: "save-image", title: "Save image", contexts: ["image"] },
  { id: "save-link", title: "Save link", contexts: ["link"] },
];

async function createMenus() {
  await ext.contextMenus.removeAll();
  for (const item of MENUS) ext.contextMenus.create(item);
}

ext.runtime.onInstalled.addListener(async ({ reason }) => {
  await createMenus();
  await afterChange();
  if (reason === "install" && !(await getSettings())) ext.runtime.openOptionsPage();
});
ext.runtime.onStartup?.addListener(() => run(queue.flush()));

async function inject(tabId, frameId, func, args = []) {
  try {
    const target = { tabId, ...(frameId ? { frameIds: [frameId] } : {}) };
    const [res] = await ext.scripting.executeScript({ target, func, args });
    return res?.result;
  } catch {
    return undefined; // a page the browser won't let extensions touch
  }
}

async function jobFor(menuId, info, tab) {
  switch (menuId) {
    case "save-selection": {
      const exact = await inject(tab.id, info.frameId, readSelection);
      return selectionJob(tab, exact || info.selectionText || "");
    }
    case "save-link":
      return linkJob(tab, info.linkUrl, info.linkText || info.selectionText);
    case "save-image":
      return imageCapture(tab, info);
    default:
      return pageJob(tab);
  }
}

// A public image goes as its URL and Athena fetches it. Anything else (a
// private network, data:, blob:) goes as the bytes the page already shows.
async function imageCapture(tab, info) {
  const src = info.srcUrl;
  if (isPublicUrl(src)) return imageJob(tab, src);
  if (/^data:image\//i.test(src) && src.length <= MAX_IMAGE_BYTES * 1.4) {
    return imageJob(tab, src, { dataUrl: src, name: "" });
  }
  const read = await inject(tab.id, info.frameId, readImage, [src, MAX_IMAGE_BYTES]);
  if (read?.dataUrl) return imageJob(tab, src, { dataUrl: read.dataUrl, name: read.name });
  const warning =
    read?.error === "size"
      ? "The image was too big to copy, so Athena has its address only."
      : "Athena has the image's address, but the extension couldn't copy the picture.";
  return imageJob(tab, src, null, warning);
}

const SAVED_TITLE = {
  page: "Saved to Athena",
  selection: "Quote saved to Athena",
  image: "Image saved to Athena",
  link: "Link saved to Athena",
};

function toastFor(kind, result) {
  if (result.status === "saved") {
    return { tone: result.warning ? "warn" : "good", title: SAVED_TITLE[kind], detail: result.warning || "", link: result.link };
  }
  if (result.status === "queued") {
    return { tone: "warn", title: "Saved for later", detail: "Couldn't reach Athena. It'll send this when it can." };
  }
  if (result.reason === "setup") {
    return { tone: "bad", title: "Set up Save to Athena first", detail: "This save is kept and goes once you add your address and key." };
  }
  return { tone: "bad", title: "Not sent yet", detail: `${result.message} The save is kept in the extension.` };
}

async function capture(menuId, info, tab) {
  if (!tab?.id || (!isSavablePage(tab.url) && menuId !== "save-image" && menuId !== "save-link")) {
    return { status: "skipped" };
  }
  const job = await jobFor(menuId, info, tab);
  if (job.kind === "selection" && !job.payload.selection) return { status: "skipped" };
  const result = await queue.add(job);
  await afterChange();
  await inject(tab.id, 0, showToast, [toastFor(job.kind, result)]);
  if (result.reason === "setup") ext.runtime.openOptionsPage();
  return result;
}

ext.contextMenus.onClicked.addListener((info, tab) => run(capture(info.menuItemId, info, tab)));

ext.commands?.onCommand.addListener(async (command, tab) => {
  if (command !== "save-page") return;
  const active = tab || (await ext.tabs.query({ active: true, currentWindow: true }))[0];
  await run(capture("save-page", {}, active));
});

// ---------- Retry ----------

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) run(queue.flush());
});
self.addEventListener?.("online", () => run(queue.flush()));

ext.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) run(queue.settingsChanged());
});

async function run(promise) {
  try {
    return await promise;
  } finally {
    await afterChange();
  }
}

/** Keeps the badge and the retry alarm in step with the outbox. */
async function afterChange() {
  const { queue: jobs } = await queue.state();
  const held = jobs.some((j) => j.status === "held");
  await ext.action.setBadgeText({ text: jobs.length ? (held ? "!" : String(jobs.length)) : "" });
  if (jobs.length) {
    await ext.action.setBadgeBackgroundColor({ color: held ? "#c8402f" : "#4c5058" });
    ext.action.setBadgeTextColor?.({ color: "#ffffff" });
  }
  await ext.action.setTitle({
    title: jobs.length
      ? `Save to Athena: ${jobs.length} waiting to send`
      : "Save to Athena",
  });
  const wake = await queue.nextWake();
  if (wake == null) await ext.alarms.clear(ALARM);
  else await ext.alarms.create(ALARM, { when: Math.max(wake, Date.now() + 30_000) });
}

// ---------- Popup and options ----------

function strip(job) {
  const { image, ...rest } = job;
  return { ...rest, hasImage: Boolean(image) };
}

const handlers = {
  async "save-page"({ tab, note }) {
    if (!isSavablePage(tab?.url)) return { status: "skipped" };
    return queue.add(pageJob(tab, note));
  },
  note: ({ id, note }) => queue.addNote(id, note),
  retry: ({ id }) => (id ? queue.retry(id) : queue.flush({ force: true })),
  dismiss: ({ id }) => queue.dismiss(id),
  async state() {
    const { queue: jobs, recent } = await queue.state();
    return { queue: jobs.map(strip), recent, settings: Boolean(await getSettings()) };
  },
  async test({ address, key }) {
    const checked = validateSettings({ address, key });
    if (!checked.ok) return { ok: false, errors: checked.errors };
    const res = await send(fetch, buildTestRequest(checked.settings));
    return { ok: res.kind === "ok", kind: res.kind, status: res.status, message: res.message };
  },
};

ext.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== ext.runtime.id || !handlers[msg?.type]) return false;
  run(handlers[msg.type](msg)).then(reply, (err) => reply({ status: "error", message: String(err?.message || err) }));
  return true;
});

// For the end-to-end test, which can't click a native context menu.
globalThis.athena = { capture, queue };

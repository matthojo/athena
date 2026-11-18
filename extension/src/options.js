import { send, setStatus } from "./icons.js";
import { renderOutbox } from "./outbox.js";
import { originPattern, validateSettings } from "./lib/settings.js";

const ext = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const status = $("status");

function fieldError(name, message) {
  const input = $(name);
  const error = $(`${name}-error`);
  input.setAttribute("aria-invalid", message ? "true" : "false");
  error.textContent = message || "";
  error.hidden = !message;
}

/**
 * Validates and asks the browser for access to the owner's Athena. The
 * permission request has to come first, while the click still counts as a
 * user gesture (Firefox is strict about that).
 */
async function checkAndAllow() {
  const checked = validateSettings({ address: $("address").value, key: $("key").value });
  fieldError("address", checked.errors?.address);
  fieldError("key", checked.errors?.key);
  if (!checked.ok) {
    status.hidden = true;
    $(checked.errors.address ? "address" : "key").focus();
    return null;
  }
  const { origin } = checked.settings;
  let granted = false;
  try {
    granted = await ext.permissions.request({ origins: [originPattern(origin)] });
  } catch {
    granted = false;
  }
  if (!granted) {
    setStatus(status, "bad", `The browser needs your OK to reach ${origin}. Try again and allow it.`);
    return null;
  }
  return checked.settings;
}

async function test(settings) {
  setStatus(status, "busy", `Checking ${settings.origin}…`);
  const res = await send("test", { address: settings.origin, key: settings.key });
  if (res.ok) setStatus(status, "good", `Connected. Saves go to ${settings.origin}.`);
  else if (res.kind === "auth") setStatus(status, "bad", "Athena didn't accept that key. Make a new capture key and paste it here.");
  else if (res.status === 0) setStatus(status, "bad", `Couldn't reach ${settings.origin}. Check the address, and that Athena is up.`);
  else if (res.status === 404 || res.status === 405) setStatus(status, "bad", "That address answered, but it can't take saves. Check the address, or update Athena.");
  else setStatus(status, "bad", res.message || `Athena answered with an error (${res.status}).`);
  return res.ok;
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = await checkAndAllow();
  if (!settings) return;
  const { settings: old } = await ext.storage.local.get("settings");
  if (old?.origin && old.origin !== settings.origin) {
    await ext.permissions.remove({ origins: [originPattern(old.origin)] }).catch(() => {});
  }
  await ext.storage.local.set({ settings });
  $("key").value = settings.key;
  $("address").value = settings.origin;
  await test(settings);
  setTimeout(refreshOutbox, 500);
});

$("test").addEventListener("click", async () => {
  const settings = await checkAndAllow();
  if (settings) await test(settings);
});

async function refreshOutbox() {
  const state = await send("state");
  renderOutbox({ wrap: $("outbox-wrap"), list: $("outbox"), count: $("outbox-count"), jobs: state.queue, onChange: refreshOutbox });
}
$("retry-all").onclick = async () => {
  await send("retry");
  refreshOutbox();
};

async function main() {
  const { settings } = await ext.storage.local.get("settings");
  if (settings) {
    $("address").value = settings.origin;
    $("key").value = settings.key;
  }
  const commands = (await ext.commands?.getAll?.()) || [];
  const shortcut = commands.find((c) => c.name === "save-page")?.shortcut;
  if (shortcut) $("shortcut").textContent = shortcut;
  refreshOutbox();
}

main();

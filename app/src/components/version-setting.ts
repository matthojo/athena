/**
 * Settings → About: which version of Athena this is, and "Check for
 * updates". The check asks GitHub's public releases API for the newest
 * release, only when the owner presses the button (lib/version.ts). Updating
 * itself happens in the owner's own repository: the README's "Updating"
 * section, or the "Update Athena" workflow's pull request.
 */
import "../styles/life.css";
import "../styles/knows.css";
import "../styles/link-text.css";
import { h } from "../lib/dom";
import { isNewer, LATEST_RELEASE_API, readLatestRelease, UPDATING_URL } from "../lib/version";

/** Set by the build from package.json (app/vite.config.ts); "dev" when it isn't. */
export function appVersion(): string {
  return typeof __ATHENA_VERSION__ === "string" ? __ATHENA_VERSION__ : "dev";
}

function link(href: string, text: string): HTMLElement {
  return h("a", { class: "text-link", href, target: "_blank", rel: "noopener noreferrer" }, text);
}

export function versionSetting(current: string = appVersion()): HTMLElement {
  const id = "athena-version";
  const intro = "Checking asks GitHub which release is newest. Nothing from your Athena goes with it.";
  const sub = h("span", { class: "life-prefs__sub", id: `${id}-sub`, "aria-live": "polite" }, intro);
  const button = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-describedby": `${id}-sub` }, "Check for updates") as HTMLButtonElement;

  button.addEventListener("click", async () => {
    button.disabled = true;
    sub.replaceChildren("Checking…");
    try {
      const res = await fetch(LATEST_RELEASE_API, { headers: { Accept: "application/vnd.github+json" } });
      const latest = res.ok ? readLatestRelease(await res.json()) : null;
      if (!latest) {
        sub.replaceChildren("There's no release to compare with yet.");
      } else if (isNewer(latest.version, current)) {
        sub.replaceChildren(`Athena ${latest.version} is out. `, link(latest.url, "What's new"), " · ", link(UPDATING_URL, "How to update"));
      } else if (current === "dev") {
        sub.replaceChildren(`This is a development build. The newest release is ${latest.version}.`);
      } else {
        sub.replaceChildren("You're on the newest release.");
      }
    } catch {
      sub.replaceChildren("Couldn't reach GitHub. Try again when you're online.");
    } finally {
      button.disabled = false;
    }
  });

  return h(
    "div",
    { class: "life-prefs__row", "data-setting": "version" },
    h("span", { class: "life-prefs__words" }, h("span", { class: "life-prefs__name" }, current === "dev" ? "Athena (development build)" : `Athena ${current}`), sub),
    button
  );
}

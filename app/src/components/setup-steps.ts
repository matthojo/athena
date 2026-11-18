/**
 * Numbered setup steps with Open and Copy buttons: registering Athena with
 * Google, Microsoft and the other services that make you bring your own
 * sign-in client, and finding a key for token services.
 *
 * The steps live here, keyed by the preset's `ownClientLabel` (or its id for
 * keys), until presets carry them as data (`setupSteps`). Services without
 * steps here fall back to the preset's own help text, so a new service works
 * without touching this file.
 *
 * Built only with h() and text nodes.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { ownClientName, type ConnectorPreset } from "../../../lib/connector-presets";
import { APP_PASSWORD_SHAPE } from "../../../lib/presets/apple";

export interface SetupStep {
  /** What to do, short: "Turn on the Gmail API". */
  title: string;
  /** One more line, when the page you land on needs a pointer. */
  sub?: string;
  /** A page to open in a new tab. */
  open?: string;
  /** Text to copy (the redirect address). */
  copy?: string;
  /** Fields that belong to this step (the client ID right where you copy it). */
  fields?: HTMLElement;
  /** A page on the server typed in the form's address field (Mastodon's): Open appears once the address names a server. */
  openOn?: string;
}

export interface SetupGuide {
  steps: SetupStep[];
  /** A warning you'll meet on the way ("Google then says it hasn't checked this app…"). */
  heads_up?: string;
  /** Roughly how long it takes, for the lede. */
  minutes?: number;
}

const GOOGLE_API: Record<string, { name: string; id: string }> = {
  gmail: { name: "Gmail API", id: "gmail.googleapis.com" },
  "google-calendar": { name: "Google Calendar API", id: "calendar-json.googleapis.com" },
  youtube: { name: "YouTube Data API v3", id: "youtube.googleapis.com" },
};

/**
 * Steps for making your own sign-in client. `fields` is the client ID and
 * secret, placed in the step where you copy them.
 */
export function clientGuide(preset: ConnectorPreset, redirect: string, fields: { id: () => HTMLElement; secret: () => HTMLElement; both: () => HTMLElement }): SetupGuide {
  switch (preset.ownClientLabel) {
    case "Google": {
      const api = GOOGLE_API[preset.id] ?? { name: `${preset.label} API`, id: "" };
      return {
        minutes: 5,
        steps: [
          {
            title: `Turn on the ${api.name}`,
            sub: "If Google asks for a project first, make one called Athena.",
            open: `https://console.cloud.google.com/apis/library${api.id ? `/${api.id}` : ""}`,
          },
          {
            title: "Name the sign-in screen",
            sub: "App name Athena, your own email, and External when it asks who can use it.",
            open: "https://console.cloud.google.com/auth/branding",
          },
          {
            title: "Publish it",
            sub: "Under Audience, choose Publish app. Left in Testing, Google signs you out every 7 days.",
            open: "https://console.cloud.google.com/auth/audience",
          },
          {
            title: "Create a sign-in client",
            sub: "Choose Web application, and add this address under Authorised redirect URIs.",
            open: "https://console.cloud.google.com/auth/clients/create",
            copy: redirect,
          },
          { title: "Paste the client ID and secret", fields: fields.both() },
        ],
        heads_up: "When you sign in, Google warns that it hasn't checked this app. It's your own app, so choose Advanced, then Go to Athena.",
      };
    }
    case "Microsoft":
      return {
        minutes: 5,
        steps: [
          {
            title: "Register Athena with Microsoft",
            sub: "Choose New registration and name it Athena. For who can sign in, pick the option that includes personal Microsoft accounts.",
            open: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
          },
          { title: "Add this address", sub: "Under Redirect URI, choose Web and paste it.", copy: redirect },
          { title: "Copy the Application (client) ID", sub: "It's on the app's Overview page.", fields: fields.id() },
          {
            title: "Make a secret",
            sub: "Under Certificates & secrets, choose New client secret and pick 24 months. Copy the Value, not the Secret ID.",
            fields: fields.secret(),
          },
        ],
        heads_up: "A work account may need your IT admin to approve Athena first.",
      };
    case "Trakt":
      return {
        minutes: 2,
        steps: [
          { title: "Make a Trakt app", sub: "Name it Athena and paste this under Redirect URI.", open: "https://trakt.tv/oauth/applications/new", copy: redirect },
          { title: "Paste its Client ID", sub: "Trakt signs in with PKCE, so you can leave the Client Secret.", fields: fields.id() },
        ],
      };
    case "Reddit":
      return {
        minutes: 2,
        steps: [
          { title: "Make a Reddit app", sub: "Choose Create app, then web app. Name it Athena and paste this as the redirect URI.", open: "https://www.reddit.com/prefs/apps", copy: redirect },
          { title: "Paste the code under the app's name, and its secret", fields: fields.both() },
        ],
        heads_up: "Reddit checks new apps by hand, so sign-in may not work for a few weeks.",
      };
    case "Spotify":
      return {
        minutes: 2,
        steps: [
          { title: "Make a Spotify app", sub: "Name it Athena, paste this as the redirect URI and tick Web API.", open: "https://developer.spotify.com/dashboard/create", copy: redirect },
          { title: "Paste the Client ID and Client secret", sub: "Both are under the app's Settings.", fields: fields.both() },
        ],
        heads_up: "Spotify only lets apps in for Premium accounts.",
      };
    case "Strava":
      return {
        minutes: 2,
        steps: [
          { title: "Make a Strava app", sub: "Name it Athena. Category and website can be anything. Paste this under Authorization Callback Domain.", open: "https://www.strava.com/settings/api", copy: new URL(redirect).host },
          { title: "Paste the Client ID and Client Secret", sub: "Both are on the same page once the app is made.", fields: fields.both() },
        ],
        heads_up: "Strava only lets you make an app if you have a Strava subscription.",
      };
    case "Oura":
      return {
        minutes: 2,
        steps: [
          { title: "Make an Oura app", sub: "Choose New application, name it Athena and paste this under Redirect URIs.", open: "https://cloud.ouraring.com/oauth/applications", copy: redirect },
          { title: "Paste the Client ID and Client Secret", fields: fields.both() },
        ],
        heads_up: "Oura only shares your data while your Oura Membership is active.",
      };
    case "Withings":
      return {
        minutes: 3,
        steps: [
          { title: "Make a Withings app", sub: "Choose Create an application, then Public API. Name it Athena and paste this as the callback URL.", open: "https://developer.withings.com/dashboard/", copy: redirect },
          { title: "Paste the Client ID and Secret", fields: fields.both() },
        ],
      };
    case "Foursquare":
      return {
        minutes: 3,
        steps: [
          { title: "Make a Foursquare project", sub: "Sign in with the account you use for Swarm, choose Create a new project and name it Athena.", open: "https://foursquare.com/developers/home" },
          { title: "Add Athena's address", sub: "In the project's settings, paste this under Redirect URL and save.", copy: redirect },
          { title: "Paste the Client ID and Client Secret", sub: "They're on the same settings page.", fields: fields.both() },
        ],
      };
    case "Whoop":
      return {
        minutes: 3,
        steps: [
          { title: "Make a Whoop app", sub: "Make a team (any name), then Create App and name it Athena. Under Scopes, tick sleep, workout, recovery and cycles. Paste this under Redirect URIs.", open: "https://developer-dashboard.whoop.com/", copy: redirect },
          { title: "Paste the Client ID and Client Secret", sub: "Both show once the app is made.", fields: fields.both() },
        ],
      };
    case "Polar":
      return {
        minutes: 3,
        steps: [
          { title: "Make a Polar app", sub: "Sign in with your Polar Flow account and choose Create client. Name it Athena and paste this as the callback URL.", open: "https://admin.polaraccesslink.com/", copy: redirect },
          { title: "Paste the Client ID and Secret", sub: "Both are on the app's page once it's made.", fields: fields.both() },
        ],
        heads_up: "Polar only shares workouts from the day you connect onwards.",
      };
    default:
      if (preset.setup) return fromPreset(preset, fields.both(), redirect);
      // No steps written yet: the preset's own help, the address, then the fields.
      return {
        steps: [
          { title: `Make a sign-in app at ${ownClientName(preset)}`, sub: preset.help, copy: redirect },
          { title: "Paste its client ID and secret", fields: fields.both() },
        ],
      };
  }
}

/** Where to find a key, for services you connect with one. `field` goes in the last step. */
export function keyGuide(preset: ConnectorPreset, field: HTMLElement): SetupGuide {
  const paste: SetupStep = { title: "Paste it here", fields: field };
  switch (preset.id) {
    case "github":
      return {
        steps: [
          {
            title: "Make a fine-grained token",
            sub: "Pick the repositories, then give Contents, Issues, Pull requests and Metadata read-only access.",
            open: "https://github.com/settings/personal-access-tokens/new",
          },
          paste,
        ],
      };
    case "linear":
      return { steps: [{ title: "Make a personal API key", sub: "Under Personal API keys, choose New key and give it Read access.", open: "https://linear.app/settings/account/security" }, paste] };
    case "lastfm":
      return { steps: [{ title: "Make a Last.fm API key", sub: "Name the app Athena and copy the API key.", open: "https://www.last.fm/api/account/create" }, paste] };
    case "icloud-calendar":
    case "icloud-contacts":
      return {
        steps: [
          { title: "Sign in at appleid.apple.com", sub: "With the Apple ID you use for iCloud.", open: "https://appleid.apple.com/account/manage" },
          { title: "Make an app-specific password", sub: "Under Sign-In and Security, choose App-Specific Passwords, then +. Call it Athena." },
          paste,
        ],
        heads_up: "One password covers Calendar and Contacts. If you change your Apple ID password, Apple turns this one off, so make another.",
      };
    case "steam":
      return { steps: [{ title: "Get a Steam Web API key", sub: "Any domain name works.", open: "https://steamcommunity.com/dev/apikey" }, paste] };
    case "readwise":
      return {
        steps: [{ title: "Copy your access token", sub: "If the page shows none, choose Get Access Token.", open: "https://readwise.io/access_token" }, paste],
        heads_up: "Your days name the books you highlighted, never the highlights. Ask can still search them for you.",
      };
    case "mastodon":
      return {
        steps: [
          { title: "Make an app on your server", sub: "Under Preferences, then Development. Name it Athena.", openOn: "/settings/applications/new" },
          { title: "Paste its access token", sub: "Open the app and copy Your access token.", fields: field },
        ],
        heads_up: "Tick only read when you make the app, so its token can't post for you.",
      };
    default:
      if (preset.setup) return fromPreset(preset, field);
      return { steps: [{ title: "Find your key", sub: preset.help }, paste] };
  }
}

/** A preset's own steps (`setup`, lib/connector-presets.ts), with the fields in the last one. */
function fromPreset(preset: ConnectorPreset, fields: HTMLElement, redirect?: string): SetupGuide {
  const s = preset.setup!;
  return {
    minutes: s.minutes,
    heads_up: s.heads_up,
    steps: [...s.steps.map((x) => ({ title: x.title, sub: x.sub, open: x.open, copy: x.copyRedirect ? redirect : undefined })), { title: s.paste.title, sub: s.paste.sub, fields }],
  };
}

/** How a service's keys start, so a wrong paste is caught before it's sent. */
export function keyShape(presetId: string): { test: RegExp; hint: string } | null {
  switch (presetId) {
    case "github":
      return { test: /^(github_pat_|ghp_|gho_)[A-Za-z0-9_]{20,}$/, hint: "GitHub keys start with github_pat_." };
    case "linear":
      return { test: /^lin_api_[A-Za-z0-9]{20,}$/, hint: "Linear keys start with lin_api_." };
    case "plex":
      // The whole View XML address works too: Athena takes the token out of it.
      return { test: /^(?:[A-Za-z0-9_-]{18,40}|https?:\/\/\S*[?&]X-Plex-Token=[A-Za-z0-9_-]{18,40}\S*)$/, hint: "It's the text after X-Plex-Token= in the address bar." };
    case "jellyfin":
      return { test: /^[a-f0-9]{32}$/i, hint: "Jellyfin keys are 32 letters and numbers." };
    case "readwise":
      return { test: /^[A-Za-z0-9]{30,80}$/, hint: "A Readwise token is one long run of letters and numbers." };
    case "icloud-calendar":
    case "icloud-contacts":
      return { test: APP_PASSWORD_SHAPE, hint: "Apple shows them as four groups of four letters, like abcd-efgh-ijkl-mnop." };
    default:
      return null;
  }
}

/** A button that copies text and says so for a moment. */
export function copyButton(text: string, label = "Copy"): HTMLButtonElement {
  const b = h("button", { class: "btn btn--soft btn--sm steps__btn", type: "button", "aria-label": `${label}: ${text}` }, icons.copy(), label) as HTMLButtonElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    clearTimeout(timer);
    b.replaceChildren(icons.check(), "Copied");
    b.classList.add("steps__btn--done");
    timer = setTimeout(() => {
      b.replaceChildren(icons.copy(), label);
      b.classList.remove("steps__btn--done");
    }, 1800);
  });
  return b;
}

function openLink(url: string, what: string): HTMLElement {
  return h("a", { class: "btn btn--soft btn--sm steps__btn", href: url, target: "_blank", rel: "noopener noreferrer", "aria-label": `Open ${what} in a new tab` }, "Open", icons.external());
}

/** Open for a page on the owner's own server: hidden until the form's address names one (serverPage). */
function openOnServer(path: string, what: string): HTMLElement {
  const a = openLink("about:blank", what);
  a.hidden = true;
  a.dataset.openOn = path;
  return a;
}

/** The server an address names (https://mastodon.social/@you, @you@mastodon.social, mastodon.social), or null. */
export function serverOrigin(raw: string): string | null {
  const s = raw.trim();
  const host = /^@?[A-Za-z0-9_]+@([A-Za-z0-9.-]+)$/.exec(s)?.[1] ?? (() => {
    try {
      const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
      return /^https?:$/.test(u.protocol) && !u.port && !u.username ? (/^\/@[A-Za-z0-9_]+@([A-Za-z0-9.-]+)/.exec(u.pathname)?.[1] ?? u.hostname) : null;
    } catch {
      return null;
    }
  })();
  return host && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) && !/\.(local|internal|localhost)$/i.test(host) ? `https://${host.toLowerCase()}` : null;
}

/** Point each server-page Open in `block` at the server the address names, or hide it. */
export function serverPages(block: HTMLElement, address: string): void {
  const origin = serverOrigin(address);
  for (const a of block.querySelectorAll<HTMLAnchorElement>("a[data-open-on]")) {
    a.hidden = !origin;
    if (origin) a.href = `${origin}${a.dataset.openOn}`;
  }
}

/** The numbered list. */
export function stepsList(guide: SetupGuide): HTMLElement {
  return h(
    "ol",
    { class: "steps" },
    ...guide.steps.map((s) =>
      h(
        "li",
        { class: "steps__item" },
        h(
          "div",
          { class: "steps__row" },
          h("div", { class: "steps__text" }, h("p", { class: "steps__title" }, s.title), s.sub ? h("p", { class: "steps__sub" }, s.sub) : null),
          s.open ? openLink(s.open, s.title) : null,
          s.openOn ? openOnServer(s.openOn, s.title) : null
        ),
        s.copy ? h("div", { class: "steps__copy" }, h("code", { class: "steps__code" }, s.copy), copyButton(s.copy)) : null,
        s.fields ?? null
      )
    )
  );
}

/** The steps with their heads-up note underneath. */
export function setupBlock(guide: SetupGuide): HTMLElement {
  return h(
    "div",
    { class: "steps-block" },
    stepsList(guide),
    guide.heads_up ? h("p", { class: "steps__note" }, icons.shield(), h("span", {}, guide.heads_up)) : null
  );
}

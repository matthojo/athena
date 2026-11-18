/**
 * Fastmail: email, read through Fastmail's own API (JMAP) with an API token
 * the owner makes in Fastmail's settings. No OAuth app to register.
 * Joined into CONNECTOR_PRESETS by lib/connector-presets.ts; see there for the fields.
 *
 * Athena calls JMAP itself (netlify/lib/connectors/fastmail-*.ts), with the
 * same tool names as Gmail and Outlook, so recipes, precheck and Ask read a
 * Fastmail account unchanged. A "Read data" token is enough: Athena only
 * sends JMAP's query and get methods, plus one new draft when drafts are on
 * (which needs "Make changes"). "Send email" is never needed.
 */
import type { ConnectorPreset } from "../connector-presets";

/** Where a token finds its account: the JMAP session. */
export const FASTMAIL_SESSION_URL = "https://api.fastmail.com/jmap/session";

/** Does Athena call Fastmail's API itself for this account? Every one with a token. */
export function fastmailDirect(c: { provider: string; auth_type: string }): boolean {
  return c.provider === "fastmail" && c.auth_type === "token";
}

export const FASTMAIL_PRESETS: ConnectorPreset[] = [
  {
    id: "fastmail",
    label: "Fastmail",
    tagline: "Search and read your email",
    icon: "mail",
    category: "email-calendar",
    url: FASTMAIL_SESSION_URL,
    auth: "token",
    scope: "",
    aliases: ["jmap", "email"],
    readTools: ["search_threads", "get_thread", "get_message", "list_labels"],
    recipes: ["email-digest", "custom"],
    setup: {
      minutes: 2,
      steps: [
        { title: "Open Fastmail's settings", sub: "Go to Privacy & Security, then API tokens, and choose New API token." },
        { title: "Name it Athena and choose JMAP", sub: "Under Protocol, pick JMAP (not MCP or Dynamic DNS)." },
        { title: "Tick Read data", sub: "Tick Make changes too only if you want Athena to save drafts. Leave Send email off." },
      ],
      paste: { title: "Paste the token here", sub: "Athena reads your mail and never sends, moves or deletes it. You can remove the token in Fastmail at any time." },
    },
    help: "Athena reads your Fastmail email with an API token you make in Fastmail: no app to register. Choose the JMAP protocol and tick Read data. To let Athena save drafts, tick Make changes as well and turn on drafts below; never tick Send email. Athena reads email only, not your calendars or contacts.",
  },
];

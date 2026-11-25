/**
 * iCloud services Athena reaches over CalDAV and CardDAV (Calendar, Contacts).
 * Joined into CONNECTOR_PRESETS by lib/connector-presets.ts; see there for the fields.
 *
 * Apple has no general iCloud API and no OAuth for it, but Calendar speaks
 * CalDAV and Contacts CardDAV, with the owner's Apple ID and an
 * app-specific password over HTTP Basic. Athena calls them itself
 * (netlify/lib/connectors/icloud-*.ts), sending only GET, PROPFIND and
 * REPORT, with Google Calendar's tool names for Calendar, so recipes,
 * precheck and Ask read it unchanged.
 */
import type { ConnectorPreset } from "../connector-presets";

export type AppleProvider = "icloud-calendar" | "icloud-contacts";

/** Where discovery starts. The account's own servers (p42-caldav.icloud.com…) come back from there. */
export const ICLOUD_CALDAV_URL = "https://caldav.icloud.com";
export const ICLOUD_CARDDAV_URL = "https://contacts.icloud.com";

export function isAppleProvider(provider: string): provider is AppleProvider {
  return provider === "icloud-calendar" || provider === "icloud-contacts";
}

/** Does Athena call iCloud itself for this account? Every iCloud account, with its Apple ID and app-specific password. */
export function appleDirect(c: { provider: string; auth_type: string }): boolean {
  return isAppleProvider(c.provider) && c.auth_type === "token";
}

/**
 * The calendars an iCloud Calendar account doesn't read, by id, kept in the
 * account's `scope` (iCloud has no OAuth scopes): space-separated, empty when
 * it reads them all. Stored as the ones switched off, so a calendar added
 * later is read without anyone having to switch it on. Athena's own
 * markers (with a colon, like the invites switch) aren't calendars.
 */
export function skippedCalendars(scope: string | null | undefined): string[] {
  return (scope ?? "").split(/\s+/).filter((id) => id && !id.includes(":"));
}

/** An app-specific password as Apple shows it: four groups of four lowercase letters. */
export const APP_PASSWORD_SHAPE = /^[a-z]{4}-?[a-z]{4}-?[a-z]{4}-?[a-z]{4}$/;

const APPLE_ID = { label: "Apple ID", placeholder: "you@icloud.com", autocomplete: "username", inputmode: "email" } as const;

const HELP =
  "Make an app-specific password at appleid.apple.com, under Sign-In and Security, then App-Specific Passwords. Name it Athena. The same password works for Calendar and Contacts.";

export const APPLE_PRESETS: ConnectorPreset[] = [
  {
    id: "icloud-calendar",
    label: "iCloud Calendar",
    tagline: "Events, attendees and notes",
    icon: "calendar",
    category: "email-calendar",
    url: ICLOUD_CALDAV_URL,
    auth: "token",
    scope: "",
    ownClientLabel: "Apple",
    username: APPLE_ID,
    readTools: ["list_events", "get_event", "search_events", "list_calendars"],
    recipes: ["calendar-meetings", "calendar-sync", "custom"],
    help: `${HELP} Athena can read your calendar but never change it.`,
  },
  {
    id: "icloud-contacts",
    label: "iCloud Contacts",
    tagline: "Names, numbers and birthdays",
    icon: "person",
    category: "email-calendar",
    url: ICLOUD_CARDDAV_URL,
    auth: "token",
    scope: "",
    ownClientLabel: "Apple",
    username: APPLE_ID,
    readTools: ["search_contacts", "get_contact", "list_contacts"],
    // In a Meetings collection, Contacts fills in each attendee in People (organisation, role, birthday).
    recipes: ["calendar-meetings", "custom"],
    help: `${HELP} Athena can read your contacts but never change them.`,
  },
];

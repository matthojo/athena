/**
 * The ways out of a draft that aren't an API call: links the device opens
 * with the words already filled in. Built in the app on tap, so the owner's
 * edits go with them; nothing leaves Athena and nothing is sent. The owner
 * presses Send in Messages, WhatsApp, Slack or their mail app.
 *
 *  - Text: `sms:<number>?&body=…` (the `?&` form works on iOS and Android).
 *  - WhatsApp: `https://wa.me/<number>?text=…`, the number in international
 *    form, digits only. No number: wa.me lets them pick the chat.
 *  - Telegram: `https://t.me/share/url?url=…`, Telegram's share picker
 *    with the text filled in (the owner picks the chat). Signal has no
 *    link that carries text, so it isn't offered.
 *  - Slack: a DM deep link when the person's Slack member ID is known.
 *    Slack links can't carry text, so the sheet copies it first.
 *  - Email: `mailto:` with subject and body.
 */

/** Dialling codes for the regions people most often write from, for numbers saved without one. */
const DIALLING: Record<string, string> = {
  GB: "44", IE: "353", US: "1", CA: "1", AU: "61", NZ: "64", FR: "33", DE: "49", ES: "34", IT: "39", NL: "31", BE: "32", PT: "351",
  CH: "41", AT: "43", SE: "46", NO: "47", DK: "45", FI: "358", PL: "48", IN: "91", ZA: "27", SG: "65", HK: "852", JP: "81",
};

/** "en-GB" → "44". Unknown regions give null. */
export function diallingCode(locale: string | undefined): string | null {
  const region = locale?.match(/[-_]([A-Za-z]{2})\b/)?.[1]?.toUpperCase();
  return (region && DIALLING[region]) || null;
}

const enc = (s: string) => encodeURIComponent(s);

/**
 * A phone number as wa.me wants it: international, digits only, no + or 00.
 * "+44 7700 900123", "0044…" and "(0)7700…" all work; a national number
 * ("07700 900123") gets `country` in place of its leading 0. Null when it
 * can't be made international or is too short to be a number.
 */
export function internationalDigits(raw: string, country: string | null = null): string | null {
  const s = raw.trim().replace(/\(0\)/g, "");
  let digits: string;
  if (s.startsWith("+")) digits = s.slice(1).replace(/\D/g, "");
  else {
    const d = s.replace(/\D/g, "");
    if (d.startsWith("00")) digits = d.slice(2);
    else if (d.startsWith("0") && country) digits = `${country}${d.replace(/^0+/, "")}`;
    // US/Canada numbers are often saved as 1 then ten digits, or ten digits alone.
    else if (country === "1" && d.length === 10) digits = `1${d}`;
    else if (d.length >= 11 && !d.startsWith("0")) digits = d;
    else return null;
  }
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** A number for the sms: link: + and digits only, as typed when it can't be made international. */
export function dialable(raw: string, country: string | null = null): string {
  const intl = internationalDigits(raw, country);
  if (intl) return `+${intl}`;
  return raw.replace(/[^\d+]/g, "");
}

/** Open Messages with the text filled in. Without a number the owner picks who it goes to. */
export function smsLink(phone: string | null | undefined, body: string, country: string | null = null): string {
  const to = phone ? dialable(phone, country) : "";
  return `sms:${to}?&body=${enc(body)}`;
}

/** Open WhatsApp with the text filled in, in the chat with that number when it's known. */
export function whatsappLink(phone: string | null | undefined, body: string, country: string | null = null): string {
  const to = phone ? internationalDigits(phone, country) : null;
  return `https://wa.me/${to ?? ""}?text=${enc(body)}`;
}

/** Open Telegram's share picker with the text filled in. The text goes in `url`, which Telegram shows as the message. */
export function telegramLink(body: string): string {
  return `https://t.me/share/url?url=${enc(body)}`;
}

/** A Slack identity as saved: a member ID (U…/W…), "T…/U…" or "T…:U…" with the workspace, or a handle. */
export function parseSlackIdentity(raw: string): { user: string | null; team: string | null; handle: string | null } {
  const s = raw.trim();
  const pair = s.match(/^(T[A-Z0-9]{6,})[/:](?:@)?([UW][A-Z0-9]{6,})$/i);
  if (pair) return { team: pair[1].toUpperCase(), user: pair[2].toUpperCase(), handle: null };
  // A link someone pasted: app.slack.com/client/T…/U… or …/team/U….
  const fromUrl = s.match(/\/(T[A-Z0-9]{6,})\/(?:.*?\/)?([UWD][A-Z0-9]{6,})\b/i);
  if (fromUrl) return { team: fromUrl[1].toUpperCase(), user: fromUrl[2].toUpperCase(), handle: null };
  const id = s.replace(/^@/, "");
  // Athena saves identities lowercased, so case doesn't decide it: a member ID is U or W, eight or more
  // letters and digits, with a digit in it. A handle like "william" or "ursula" isn't one.
  if (/^[UW][A-Z0-9]{7,}$/i.test(id) && /\d/.test(id)) return { user: id.toUpperCase(), team: null, handle: null };
  return { user: null, team: null, handle: id || null };
}

/**
 * Open the DM with them in Slack: the app's own link with the workspace,
 * or Slack's redirect, which finds the workspace itself. A handle alone
 * can't be opened, so that's null (the sheet offers Open Slack instead).
 */
export function slackDmLink(identity: string | null | undefined, team: string | null = null): string | null {
  if (!identity) return null;
  const parsed = parseSlackIdentity(identity);
  if (!parsed.user) return null;
  const workspace = parsed.team ?? team;
  // A D… id is the DM itself (from a pasted link); U…/W… is the person.
  if (workspace) return `slack://${parsed.user.startsWith("D") ? "channel" : "user"}?team=${enc(workspace)}&id=${enc(parsed.user)}`;
  return `https://slack.com/app_redirect?channel=${enc(parsed.user)}`;
}

/** Slack itself, when there's no DM to open. */
export const SLACK_OPEN = "slack://open";

/** A ready-filled email in the owner's mail app. Spaces as %20, which every mail app reads. */
export function mailtoLink(to: string[], subject: string, body: string): string {
  const q = [subject ? `subject=${enc(subject)}` : "", body ? `body=${enc(body)}` : ""].filter(Boolean).join("&");
  return `mailto:${to.map(enc).join(",")}${q ? `?${q}` : ""}`;
}

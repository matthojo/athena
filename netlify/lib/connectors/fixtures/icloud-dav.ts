/**
 * CalDAV and CardDAV replies in iCloud's shapes (multistatus with iCloud's
 * namespaces and partition hosts, Calendar-written iCalendar with VTIMEZONE,
 * Contacts-written vCard 3.0 with item groups and X-ABLabel), trimmed, with
 * ids shortened and people replaced. Written from iCloud's replies as
 * CalDAV clients document them; not captured from a live account (see
 * docs/notes/icloud.md). Used by icloud.test.ts.
 */

const ms = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<multistatus xmlns="DAV:">${body}</multistatus>`;

// ---------- Discovery ----------

export const CALDAV_PRINCIPAL = ms(
  `<response><href>/</href><propstat><prop><current-user-principal><href>/123456789/principal/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
);

export const CALDAV_HOME = ms(
  `<response xmlns="DAV:"><href>/123456789/principal/</href><propstat><prop><calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">https://p42-caldav.icloud.com:443/123456789/calendars/</href></calendar-home-set><calendar-user-address-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">mailto:jordan@icloud.com</href><href xmlns="DAV:">mailto:Jordan@jr.example</href><href xmlns="DAV:">/123456789/principal/</href></calendar-user-address-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
);

export const CARDDAV_PRINCIPAL = ms(
  `<response><href>/</href><propstat><prop><current-user-principal><href>/123456789/principal/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
);

export const CARDDAV_HOME = ms(
  `<response><href>/123456789/principal/</href><propstat><prop><addressbook-home-set xmlns="urn:ietf:params:xml:ns:carddav"><href xmlns="DAV:">https://p42-contacts.icloud.com:443/123456789/carddavhome/</href></addressbook-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
);

// ---------- Calendars ----------

const TZ_LONDON = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Apple Inc.//iPhone OS 18.1//EN
BEGIN:VTIMEZONE
TZID:Europe/London
BEGIN:DAYLIGHT
TZOFFSETFROM:+0000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
DTSTART:19810329T010000
TZNAME:BST
TZOFFSETTO:+0100
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0100
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
DTSTART:19961027T020000
TZNAME:GMT
TZOFFSETTO:+0000
END:STANDARD
END:VTIMEZONE
END:VCALENDAR`;

const cal = (href: string, name: string, opts: { comps?: string[]; shared?: boolean; write?: boolean; color?: string; tz?: string } = {}) =>
  `<response><href>${href}</href><propstat><prop><displayname>${name}</displayname><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/>${
    opts.shared ? `<shared xmlns="http://calendarserver.org/ns/"/>` : ""
  }</resourcetype><supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav">${(opts.comps ?? ["VEVENT"]).map((c) => `<comp name="${c}"/>`).join("")}</supported-calendar-component-set><current-user-privilege-set><privilege><read/></privilege>${
    opts.write === false ? "" : `<privilege><write/></privilege>`
  }</current-user-privilege-set>${
    opts.shared ? `<invite xmlns="http://calendarserver.org/ns/"><user><href xmlns="DAV:">mailto:jordan@icloud.com</href><invite-accepted/><access><read/></access></user><organizer><href xmlns="DAV:">mailto:rowan@example.com</href><organizer-first>Rowan</organizer-first><organizer-last>Thorne</organizer-last></organizer></invite>` : ""
  }${opts.color ? `<calendar-color xmlns="http://apple.com/ns/ical/">${opts.color}</calendar-color>` : ""}${
    opts.tz ? `<calendar-timezone xmlns="urn:ietf:params:xml:ns:caldav"><![CDATA[${opts.tz}]]></calendar-timezone>` : ""
  }</prop><status>HTTP/1.1 200 OK</status></propstat><propstat><prop><calendar-description xmlns="urn:ietf:params:xml:ns:caldav"/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response>`;

/** PROPFIND Depth 1 on the calendar home: the home itself, Work, Home, a shared Family calendar, a Reminders list, the inbox and outbox. */
export const CALENDARS = ms(
  [
    `<response><href>/123456789/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
    cal("/123456789/calendars/8F3A2C10-WORK/", "Work", { color: "#1BADF8FF", tz: TZ_LONDON }),
    cal("/123456789/calendars/home/", "Home", { color: "#FF2968FF", tz: TZ_LONDON }),
    cal("/123456789/calendars/C77-FAMILY/", "Family", { shared: true, write: false, color: "#63DA38FF" }),
    cal("/123456789/calendars/tasks/", "Reminders", { comps: ["VTODO"] }),
    `<response><href>/123456789/calendars/inbox/</href><propstat><prop><resourcetype><collection/><schedule-inbox xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
    `<response><href>/123456789/calendars/outbox/</href><propstat><prop><resourcetype><collection/><schedule-outbox xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
  ].join(""),
);

// ---------- Events (calendar-query REPORT replies) ----------

const vcal = (...events: string[]) => `${TZ_LONDON.replace("END:VCALENDAR", "")}${events.join("\n")}\nEND:VCALENDAR`.replace(/\n/g, "\r\n");
const item = (href: string, data: string) =>
  `<response><href>${href}</href><propstat><prop><getetag>"mh${href.length}"</getetag><calendar-data xmlns="urn:ietf:params:xml:ns:caldav"><![CDATA[${data}]]></calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>`;

/**
 * A weekly stand-up as a series iCloud didn't expand: Mondays 09:30 London
 * from 19 Oct 2026 (across the 25 Oct clock change), 2 Nov moved to 10:00
 * with a new title, 9 Nov skipped. Owner is an attendee, Priya organises.
 */
export const STANDUP_ICS = vcal(
  `BEGIN:VEVENT
UID:STANDUP-1
DTSTAMP:20261001T080000Z
LAST-MODIFIED:20261012T080000Z
DTSTART;TZID=Europe/London:20261019T093000
DTEND;TZID=Europe/London:20261019T094500
RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261130T235959Z
EXDATE;TZID=Europe/London:20261109T093000
SUMMARY:Team stand-up
LOCATION:Zoom
DESCRIPTION:Join: https://acme.zoom.us/j/123456789\\nAgenda in the doc.
ORGANIZER;CN=Priya Shah:mailto:priya@acme.example
ATTENDEE;CN=Priya Shah;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:priya@acme.example
ATTENDEE;CN=Jordan;PARTSTAT=ACCEPTED:mailto:jordan@icloud.com
ATTENDEE;CN=Sam Lee;PARTSTAT=TENTATIVE;ROLE=OPT-PARTICIPANT:mailto:sam@acme.example
ATTENDEE;CN=Board Room;CUTYPE=ROOM;PARTSTAT=ACCEPTED:mailto:room@acme.example
END:VEVENT`,
  `BEGIN:VEVENT
UID:STANDUP-1
DTSTAMP:20261028T080000Z
RECURRENCE-ID;TZID=Europe/London:20261102T093000
DTSTART;TZID=Europe/London:20261102T100000
DTEND;TZID=Europe/London:20261102T101500
SUMMARY:Team stand-up (moved)
ORGANIZER;CN=Priya Shah:mailto:priya@acme.example
ATTENDEE;CN=Jordan;PARTSTAT=NEEDS-ACTION:mailto:jordan@icloud.com
END:VEVENT`,
);

/** The same series as iCloud returns it when it does expand: each occurrence a VEVENT with its RECURRENCE-ID, in UTC. */
export const STANDUP_EXPANDED = vcal(
  ...[
    ["20261019T083000Z", "20261019T083000Z", "20261019T084500Z", "Team stand-up"],
    ["20261026T093000Z", "20261026T093000Z", "20261026T094500Z", "Team stand-up"],
    ["20261102T093000Z", "20261102T100000Z", "20261102T101500Z", "Team stand-up (moved)"],
  ].map(
    ([rid, s, e, t]) => `BEGIN:VEVENT
UID:STANDUP-1
RECURRENCE-ID:${rid}
DTSTART:${s}
DTEND:${e}
SUMMARY:${t}
ATTENDEE;CN=Jordan;PARTSTAT=ACCEPTED:mailto:jordan@icloud.com
END:VEVENT`,
  ),
);

export const DENTIST_ICS = vcal(`BEGIN:VEVENT
UID:DENTIST-1
DTSTART;TZID=Europe/London:20261104T161500
DURATION:PT45M
SUMMARY:Dentist
LOCATION:12 High Street\\, Bath
STATUS:TENTATIVE
END:VEVENT`);

export const TRIP_ICS = vcal(`BEGIN:VEVENT
UID:TRIP-1
DTSTART;VALUE=DATE:20261106
DTEND;VALUE=DATE:20261108
SUMMARY:Lisbon
X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC
END:VEVENT`);

export const CANCELLED_ICS = vcal(`BEGIN:VEVENT
UID:LUNCH-1
DTSTART:20261105T123000Z
DTEND:20261105T133000Z
SUMMARY:Lunch with Alex
STATUS:CANCELLED
END:VEVENT`);

const HOME = "/123456789/calendars/home/";
export const EVENT_HREF = { standup: `${HOME}STANDUP-1.ics`, dentist: `${HOME}DENTIST-1.ics`, trip: `${HOME}TRIP-1.ics`, cancelled: `${HOME}LUNCH-1.ics` };

/** REPORT on Home: the series unexpanded, plus the rest. */
export const HOME_REPORT = ms([item(EVENT_HREF.standup, STANDUP_ICS), item(EVENT_HREF.dentist, DENTIST_ICS), item(EVENT_HREF.trip, TRIP_ICS), item(EVENT_HREF.cancelled, CANCELLED_ICS)].join(""));
/** REPORT on Home when iCloud expands the series. */
export const HOME_REPORT_EXPANDED = ms(item(EVENT_HREF.standup, STANDUP_EXPANDED));
/** REPORT on Work: one event. */
export const WORK_REPORT = ms(
  item(
    "/123456789/calendars/8F3A2C10-WORK/QBR.ics",
    vcal(`BEGIN:VEVENT
UID:QBR-1
DTSTART:20261103T140000Z
DTEND:20261103T150000Z
SUMMARY:QBR with Acme
DESCRIPTION:Priya to bring the numbers.
ATTENDEE;CN=Priya Shah;PARTSTAT=ACCEPTED:mailto:priya@acme.example
END:VEVENT`),
  ),
);
export const EMPTY_REPORT = ms("");

// ---------- Contacts ----------

const BOOK = "/123456789/carddavhome/card/";

export const BOOKS = ms(
  `<response><href>/123456789/carddavhome/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response><response><href>${BOOK}</href><propstat><prop><resourcetype><collection/><addressbook xmlns="urn:ietf:params:xml:ns:carddav"/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
);

const CARD_IDS = ["A1B2-PRIYA", "C3D4-SAM", "E5F6-GROUP", "G7H8-ZOE"];
export const CARD_HREF = (id: string) => `${BOOK}${id}.vcf`;

export const CARD_LIST = ms(
  [
    `<response><href>${BOOK}</href><propstat><prop><getetag>"c0"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
    ...CARD_IDS.map((id) => `<response><href>${CARD_HREF(id)}</href><propstat><prop><getetag>"${id}"</getetag><getcontenttype>text/vcard</getcontenttype></prop><status>HTTP/1.1 200 OK</status></propstat></response>`),
  ].join(""),
);

const vcf = (lines: string) => lines.trim().replace(/\n/g, "\r\n");

export const CARDS: Record<string, string> = {
  "A1B2-PRIYA": vcf(`BEGIN:VCARD
VERSION:3.0
PRODID:-//Apple Inc.//iPhone OS 18.1//EN
N:Shah;Priya;;;
FN:Priya Shah
ORG:Acme Ltd;Finance;
TITLE:Head of Finance
item1.EMAIL;type=INTERNET;type=pref:priya@acme.example
item1.X-ABLabel:_$!<Work>!$_
EMAIL;type=INTERNET;type=HOME:priya.shah@mail.example
TEL;type=CELL;type=VOICE;type=pref:+44 7700 900123
TEL;type=WORK;type=VOICE:020 7946 0018
item2.ADR;type=WORK;type=pref:;;1 Market St\\nFloor 4;London;;EC1A 1BB;United Kingdom
item2.X-ABADR:gb
BDAY;X-APPLE-OMIT-YEAR=1604:1604-04-12
NOTE:Met at the Lisbon offsite.
item3.X-ABRELATEDNAMES:Arjun
item3.X-ABLabel:_$!<Spouse>!$_
PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/
REV:2026-10-30T09:12:44Z
UID:A1B2-PRIYA
END:VCARD`),
  "C3D4-SAM": vcf(`BEGIN:VCARD
VERSION:3.0
N:Lee;Sam;;;
FN:Sam Lee
ORG:Acme Ltd;
item1.TEL:07700 900456
item1.X-ABLabel:Studio
BDAY:1990-02-28
item2.URL;type=pref:https://samlee.example
item2.X-ABLabel:_$!<HomePage>!$_
UID:C3D4-SAM
END:VCARD`),
  "E5F6-GROUP": vcf(`BEGIN:VCARD
VERSION:3.0
N:Book club
FN:Book club
X-ADDRESSBOOKSERVER-KIND:group
X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:A1B2-PRIYA
UID:E5F6-GROUP
END:VCARD`),
  "G7H8-ZOE": vcf(`BEGIN:VCARD
VERSION:3.0
N:Adams;Zoë;;Dr;
FN:Dr Zoë Adams
NICKNAME:Zo
EMAIL;type=INTERNET:zoe@clinic.example
UID:G7H8-ZOE
END:VCARD`),
};

export function multigetReply(hrefs: string[]): string {
  return ms(
    hrefs
      .map((h) => {
        const id = h.slice(h.lastIndexOf("/") + 1).replace(/\.vcf$/, "");
        return CARDS[id]
          ? `<response><href>${h}</href><propstat><prop><getetag>"${id}"</getetag><address-data xmlns="urn:ietf:params:xml:ns:carddav"><![CDATA[${CARDS[id]}]]></address-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>`
          : `<response><href>${h}</href><status>HTTP/1.1 404 Not Found</status></response>`;
      })
      .join(""),
  );
}

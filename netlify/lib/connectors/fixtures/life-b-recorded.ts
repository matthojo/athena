/**
 * Recorded replies for the ListenBrainz, Raindrop.io and Eventbrite tests (life-b-direct.test.ts).
 *
 * ListenBrainz: real replies from api.listenbrainz.org on 9 Nov 2026 (a
 * public profile's listens, trimmed to the fields Athena reads, the username
 * replaced), its unknown-user reply, plus one listen from the day before
 * shaped like the rest so a page spans two days.
 * Raindrop.io and Eventbrite: their real bad-token replies from the same day.
 * Their success bodies follow the documented shapes
 * (developer.raindrop.io, eventbrite.com/platform/api), since reading one
 * needs a real account; names and ids are made up.
 */
export { at, calls, stub, unstub } from "./reading-social-recorded";

// ---------- ListenBrainz ----------

/** GET /1/user/<name>/listens?count=3, then ?count=2&max_ts=<the third's listened_at>. */
export const LISTENS = [
  {
    "listened_at": 1771414109,
    "recording_msid": "fd0cad33-ea33-453b-8155-1292379277db",
    "track_metadata": {
      "artist_name": "Röyksopp",
      "track_name": "Some Resolve",
      "release_name": "Profound Mysteries II",
      "additional_info": {
        "duration_ms": 402390,
        "recording_mbid": "30d08f4c-d825-4ae1-b79c-44242cddd7c0",
        "submission_client": "navidrome"
      },
      "mbid_mapping": {
        "recording_mbid": "30d08f4c-d825-4ae1-b79c-44242cddd7c0",
        "release_mbid": "e96c2e7b-94fd-4fbe-9c44-1a27d8664825",
        "recording_name": "Some Resolve"
      }
    },
    "user_name": "someone"
  },
  {
    "listened_at": 1771413706,
    "recording_msid": "e0f102e3-e1ea-4b24-8fa7-f7df48f80afc",
    "track_metadata": {
      "artist_name": "Röyksopp feat. Susanne Sundfør",
      "track_name": "Tell Him",
      "release_name": "Profound Mysteries II",
      "additional_info": {
        "duration_ms": 326560,
        "recording_mbid": "46f0b53f-6731-457c-93e7-57cff0e5b0c2",
        "submission_client": "navidrome"
      },
      "mbid_mapping": {
        "recording_mbid": "46f0b53f-6731-457c-93e7-57cff0e5b0c2",
        "release_mbid": "e96c2e7b-94fd-4fbe-9c44-1a27d8664825",
        "recording_name": "Tell Him"
      }
    },
    "user_name": "someone"
  },
  {
    "listened_at": 1771413380,
    "recording_msid": "067530cc-6dff-4981-8753-ebd1cb76d185",
    "track_metadata": {
      "artist_name": "Röyksopp",
      "track_name": "Remembering the Departed",
      "release_name": "Profound Mysteries II",
      "additional_info": {
        "duration_ms": 229690,
        "recording_mbid": "a8eb2940-b706-4e35-afd2-f15feec4eb20",
        "submission_client": "navidrome"
      },
      "mbid_mapping": {
        "recording_mbid": "a8eb2940-b706-4e35-afd2-f15feec4eb20",
        "release_mbid": "e96c2e7b-94fd-4fbe-9c44-1a27d8664825",
        "recording_name": "Remembering the Departed"
      }
    },
    "user_name": "someone"
  },
  {
    "listened_at": 1771413150,
    "recording_msid": "6767e940-2c06-4a15-aa4f-bccf03fca8b5",
    "track_metadata": {
      "artist_name": "Röyksopp feat. Pixx",
      "track_name": "It Was a Good Thing",
      "release_name": "Profound Mysteries II",
      "additional_info": {
        "duration_ms": 253000,
        "recording_mbid": "100bdac3-db86-41ba-b987-6f639914834c",
        "submission_client": "navidrome"
      },
      "mbid_mapping": {
        "recording_mbid": "100bdac3-db86-41ba-b987-6f639914834c",
        "release_mbid": "e96c2e7b-94fd-4fbe-9c44-1a27d8664825",
        "recording_name": "It Was a Good Thing"
      }
    },
    "user_name": "someone"
  },
  {
    "listened_at": 1771412897,
    "recording_msid": "3965d2b1-b4ec-4a54-aff9-3c60af548941",
    "track_metadata": {
      "artist_name": "Röyksopp",
      "track_name": "Control",
      "release_name": "Profound Mysteries II",
      "additional_info": {
        "duration_ms": 373830,
        "recording_mbid": "0228a5f7-fd54-4b8c-8d7c-7c6f2d0163b8",
        "submission_client": "navidrome"
      },
      "mbid_mapping": {
        "recording_mbid": "0228a5f7-fd54-4b8c-8d7c-7c6f2d0163b8",
        "release_mbid": "e96c2e7b-94fd-4fbe-9c44-1a27d8664825",
        "recording_name": "Control"
      }
    },
    "user_name": "someone"
  }
];

/** One more, the evening before (17 Feb 2026, 21:40 UTC). */
export const LISTEN_DAY_BEFORE = {
  listened_at: 1771364400,
  recording_msid: "0b9c2a51-5c66-4a8e-9f1e-2d7a1b3c4d5e",
  track_metadata: { artist_name: "Röyksopp", track_name: "The Ladder", release_name: "The Understanding", additional_info: { duration_ms: 395000, submission_client: "navidrome" }, mbid_mapping: null },
  user_name: "someone",
};

export const LISTEN_COUNT = { payload: { count: 220287 } };
/** The real reply for a username ListenBrainz doesn't know (404). */
export const LISTENBRAINZ_NO_USER = { code: 404, error: "Cannot find user: nosuchuser-zz9q8" };

// ---------- Raindrop.io ----------

/** The real reply to a token Raindrop doesn't know (401). */
export const RAINDROP_BAD_TOKEN = { result: false, status: 401, errorMessage: "Incorrect access_token", auth: false };
export const RAINDROP_USER = { result: true, user: { _id: 1234567, fullName: "Sam" } };
export const RAINDROP_COLLECTIONS = { result: true, items: [{ _id: 41001, title: "Recipes" }, { _id: 41002, title: "Reading" }] };
export const RAINDROP_CHILDREN = { result: true, items: [{ _id: 41003, title: "Weeknight", parent: { $id: 41001 } }] };

const drop = (id: number, title: string, created: string, extra: Record<string, unknown> = {}) => ({
  _id: id,
  title,
  link: `https://example.com/${id}`,
  domain: "example.com",
  excerpt: "",
  type: "link",
  tags: [],
  important: false,
  created,
  lastUpdate: created,
  collection: { $id: 41002 },
  ...extra,
});

/** /raindrops/0?sort=-created&perpage=50&page=0: a full page, newest first, spanning 7 and 6 Nov. */
export const RAINDROP_PAGE_0 = {
  result: true,
  count: 52,
  collectionId: 0,
  items: [
    drop(900, "How to make sourdough", "2026-11-07T19:30:00.000Z", { domain: "www.seriouseats.com", link: "https://www.seriouseats.com/sourdough", type: "article", tags: ["bread"], collection: { $id: 41003 }, important: true }),
    drop(899, "A talk on maps", "2026-11-07T08:10:00.000Z", { domain: "youtube.com", link: "https://youtube.com/watch?v=abc", type: "video", collection: { $id: -1 } }),
    ...Array.from({ length: 48 }, (_, i) => drop(898 - i, `Link ${898 - i}`, `2026-11-06T${String(23 - Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "00" : "30"}:00.000Z`)),
  ],
};
/** page=1: the last two, from 5 Nov. */
export const RAINDROP_PAGE_1 = { result: true, count: 52, collectionId: 0, items: [drop(850, "An older one", "2026-11-05T12:00:00.000Z"), drop(849, "The oldest", "2026-11-05T09:00:00.000Z")] };

// ---------- Eventbrite ----------

/** The real reply to a token Eventbrite doesn't know (401). */
export const EVENTBRITE_BAD_TOKEN = { error: "INVALID_AUTH", error_description: "The OAuth token you provided was invalid.", status_code: 401 };
export const EVENTBRITE_ME = { id: "100000000001", name: "Sam", emails: [{ email: "sam@example.com", primary: true }] };

const order = (id: string, status: string, name: string, local: string, utc: string, endUtc: string, venue: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  id,
  created: "2026-09-01T10:00:00Z",
  status,
  name: "Sam Example",
  email: "sam@example.com",
  costs: { gross: { display: "£24.50", value: 2450, currency: "GBP" } },
  event_id: `e${id}`,
  event: {
    id: `e${id}`,
    name: { text: name, html: name },
    start: { timezone: "Europe/London", local, utc },
    end: { timezone: "Europe/London", local, utc: endUtc },
    url: `https://www.eventbrite.co.uk/e/${id}`,
    online_event: venue === null,
    venue,
    ...extra,
  },
});

/** /users/me/orders/?expand=event,event.venue: page one (has_more_items), then page two by continuation. */
export const EVENTBRITE_ORDERS_1 = {
  pagination: { object_count: 4, page_number: 1, page_size: 2, page_count: 2, continuation: "dGhlIG5leHQgcGFnZQ", has_more_items: true },
  orders: [
    order("5001", "placed", "Late night at the museum", "2026-10-24T19:00:00", "2026-10-24T18:00:00Z", "2026-10-24T22:00:00Z", { name: "Natural History Museum", address: { city: "London", address_1: "Cromwell Road", postal_code: "SW7 5BD" } }),
    order("5002", "refunded", "A cancelled gig", "2026-10-10T20:00:00", "2026-10-10T19:00:00Z", "2026-10-10T23:00:00Z", { name: "Somewhere", address: { city: "London" } }),
  ],
};
export const EVENTBRITE_ORDERS_2 = {
  pagination: { object_count: 4, page_number: 2, page_size: 2, page_count: 2, has_more_items: false },
  orders: [
    order("5003", "placed", "Talk: the history of maps", "2026-09-30T18:30:00", "2026-09-30T17:30:00Z", "2026-09-30T19:00:00Z", null),
    order("5004", "placed", "Supper club", "2026-12-05T19:30:00", "2026-12-05T19:30:00Z", "2026-12-05T22:30:00Z", { name: "The Kitchen", address: { city: "Bristol" } }),
  ],
};

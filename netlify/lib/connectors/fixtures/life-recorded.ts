/**
 * Replies for the Habitify, Monzo, Starling and Octopus tests, anonymised.
 *
 * Refusals are recorded from the live APIs (7 Nov 2026, a made-up token):
 * Monzo's invalid token, Starling's, Octopus's missing credentials, Habitify's
 * empty 401 and Todoist's. Successful replies need a real account, so they
 * follow each service's documented shape (docs.habitify.me, docs.monzo.com,
 * developer.starlingbank.com/docs, Octopus's REST guide, developer.todoist.com),
 * with the fields Athena reads and a few it ignores. Replace them with
 * recorded replies once the owner connects (docs/notes/habits-money-home.md).
 *
 * The fetch stub is reading-social-recorded.ts's.
 */
export { at, calls, stub, unstub, type Reply, type Route } from "./reading-social-recorded";

// ---------- Habitify ----------

export const HABITS = {
  message: "Success",
  data: [
    { id: "-MkRead01", name: "Read 20 pages", is_archived: false, start_date: "2026-01-01T00:00:00.000Z", type: "good", goal: { value: 20, unit_type: "page", periodicity: "daily" } },
    { id: "-MkWater02", name: "Drink water", is_archived: false, start_date: "2026-01-01T00:00:00.000Z", type: "good", goal: { value: 5, unit_type: "glass", periodicity: "daily" } },
    { id: "-MkStretch03", name: "Stretch", is_archived: false, start_date: "2026-01-01T00:00:00.000Z", type: "good", goal: { value: 1, unit_type: "rep", periodicity: "daily" } },
    { id: "-MkPhone04", name: "No phone in bed", is_archived: false, start_date: "2026-01-01T00:00:00.000Z", type: "bad" },
    { id: "-MkSmoke05", name: "No snacks after 9pm", is_archived: false, start_date: "2026-01-01T00:00:00.000Z", type: "bad" },
    { id: "-MkOld06", name: "Old habit", is_archived: true, start_date: "2025-01-01T00:00:00.000Z", type: "good" },
    { id: "-MkLater07", name: "Starts next year", is_archived: false, start_date: "2027-01-01T00:00:00.000Z", type: "good" },
  ],
  version: "v2",
  status: true,
};

/** The journal for 6 Nov 2026: good habits only (Habitify's bad-habit bug). */
export const JOURNAL = {
  message: "Success",
  data: [
    { id: "-MkRead01", name: "Read 20 pages", is_archived: false, status: "completed", progress: { current_value: 20, target_value: 20, unit_type: "page" } },
    { id: "-MkWater02", name: "Drink water", is_archived: false, status: "in_progress", progress: { current_value: 3, target_value: 5, unit_type: "glass" } },
    { id: "-MkStretch03", name: "Stretch", is_archived: false, status: "skipped", progress: { current_value: 0, target_value: 1, unit_type: "rep" } },
  ],
  version: "v2",
  status: true,
};

/** Logs: the phone in bed was logged (it happened); snacks weren't (avoided). */
export const LOGS: Record<string, unknown> = {
  "-MkPhone04": { message: "Success", data: [{ id: "l1", value: 1, created_date: "2026-11-06T23:10:00.000Z", unit_type: "rep" }] },
  "-MkSmoke05": { message: "Success", data: [] },
  "-MkWater02": {
    message: "Success",
    data: [
      { id: "w1", value: 1, created_date: "2026-11-06T08:00:00.000Z", unit_type: "glass" },
      { id: "w2", value: 2, created_date: "2026-11-06T13:30:00.000Z", unit_type: "glass" },
    ],
  },
};

/** Recorded: a 401 with an empty body. */
export const HABITIFY_UNAUTHORISED = null;

// ---------- Monzo ----------

export const MONZO_TOKEN = { access_token: "monzo_access_1", client_id: "oauth2client_00009", expires_in: 21600, refresh_token: "monzo_refresh_1", token_type: "Bearer", user_id: "user_00009" };
export const MONZO_ACCOUNTS = { accounts: [{ id: "acc_00009abc", closed: false, created: "2019-03-01T10:00:00.000Z", type: "uk_retail", currency: "GBP" }] };
export const MONZO_NOT_APPROVED = { code: "forbidden.insufficient_permissions", message: "Access forbidden due to insufficient permissions" };
export const MONZO_SCA = { code: "forbidden.verification_required", message: "Verification required" };
/** Recorded: Monzo answers a bad or expired token with 400, not 401. */
export const MONZO_UNAUTH = { code: "bad_request.invalid_token", message: "Token is invalid", retryable: {}, marshal_count: 1 };

const mtx = (id: string, created: string, amount: number, category: string, merchant: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  created,
  amount,
  currency: "GBP",
  category,
  description: merchant ? merchant.toUpperCase() : "POT TRANSFER",
  include_in_spending: true,
  decline_reason: undefined,
  settled: created,
  scheme: "mastercard",
  merchant: merchant ? { id: `merch_${id}`, name: merchant, category, emoji: "" } : null,
  ...extra,
});

/** 6 Nov 2026 in London (GMT): lunch, a supermarket, a Deliveroo, a pot move, a decline, a refund, and 00:30 on the 7th. */
export const MONZO_TXNS = [
  mtx("tx_001", "2026-11-06T12:40:11.000Z", -1800, "eating_out", "Dishoom"),
  mtx("tx_002", "2026-11-06T17:55:00.000Z", -2400, "groceries", "Waitrose & Partners"),
  mtx("tx_003", "2026-11-06T20:15:00.000Z", -2150, "eating_out", "Deliveroo"),
  mtx("tx_004", "2026-11-06T09:00:00.000Z", -5000, "savings", null, { scheme: "uk_retail_pot", include_in_spending: false }),
  mtx("tx_005", "2026-11-06T10:00:00.000Z", -999, "shopping", "Gadget Shop", { decline_reason: "INSUFFICIENT_FUNDS" }),
  mtx("tx_006", "2026-11-06T11:00:00.000Z", 1200, "shopping", "Amazon"),
  mtx("tx_007", "2026-11-07T00:30:00.000Z", -650, "transport", "TfL Travel Charge"),
];

export const MONZO_POTS = { pots: [{ id: "pot_0001", name: "Holiday", balance: 123456, deleted: false }, { id: "pot_0002", name: "Old", balance: 0, deleted: true }] };

// ---------- Starling ----------

export const STARLING_ACCOUNTS = {
  accounts: [{ accountUid: "aaaaaaaa-1111-2222-3333-444444444444", accountType: "PRIMARY", defaultCategory: "cccccccc-1111-2222-3333-444444444444", currency: "GBP", createdAt: "2020-01-01T00:00:00.000Z", name: "Personal" }],
};
export const STARLING_FORBIDDEN = { error: "insufficient_scope", error_description: "Token does not have the required scope transaction:read" };
export const STARLING_UNAUTH = { error: "invalid_token", error_description: "Could not validate provided access token" };

const feed = (uid: string, time: string, minor: number, category: string, name: string, extra: Record<string, unknown> = {}) => ({
  feedItemUid: uid,
  categoryUid: "cccccccc-1111-2222-3333-444444444444",
  amount: { currency: "GBP", minorUnits: minor },
  sourceAmount: { currency: "GBP", minorUnits: minor },
  direction: "OUT",
  updatedAt: time,
  transactionTime: time,
  settlementTime: time,
  source: "MASTER_CARD",
  status: "SETTLED",
  counterPartyType: "MERCHANT",
  counterPartyName: name,
  spendingCategory: category,
  ...extra,
});

/** 6 Nov 2026 London: coffee, a takeaway, a move to a Space, money in, a reversal. */
export const STARLING_FEED = {
  feedItems: [
    feed("f-001", "2026-11-06T08:10:00.000Z", 340, "EATING_OUT", "Pret A Manger"),
    feed("f-002", "2026-11-06T19:45:00.000Z", 2600, "TAKEAWAY", "Just Eat"),
    feed("f-003", "2026-11-06T09:00:00.000Z", 10000, "SAVING", "Rainy day", { source: "INTERNAL_TRANSFER", counterPartyType: "CATEGORY" }),
    feed("f-004", "2026-11-06T09:30:00.000Z", 250000, "INCOME", "Employer Ltd", { direction: "IN" }),
    feed("f-005", "2026-11-06T15:00:00.000Z", 4500, "SHOPPING", "Shoe Shop", { status: "REVERSED" }),
  ],
};

// ---------- Octopus ----------

/** Half hours for 6 Nov 2026 (GMT): low overnight, a morning bump, most of it 18:00–22:00. */
export function octopusDay(date = "2026-11-06", pattern: (slot: number) => number = (i) => (i >= 36 && i < 44 ? 0.6 : i >= 14 && i < 16 ? 0.3 : 0.05)) {
  const start = Date.parse(`${date}T00:00:00Z`);
  return Array.from({ length: 48 }, (_, i) => ({
    consumption: Math.round(pattern(i) * 1000) / 1000,
    interval_start: new Date(start + i * 1_800_000).toISOString().replace(".000Z", "Z"),
    interval_end: new Date(start + (i + 1) * 1_800_000).toISOString().replace(".000Z", "Z"),
  }));
}

export const OCTOPUS_UNAUTH = { detail: "Authentication credentials were not provided." };
export const OCTOPUS_NOT_FOUND = { detail: "Not found." };

/** GET /v1/accounts/{number}/, cut down to what Athena reads (Octopus's REST guide): a home moved out of, an export meter, a replaced gas meter. */
export const OCTOPUS_ACCOUNT = {
  number: "A-1234ABCD",
  properties: [
    {
      id: 1,
      moved_in_at: "2019-03-01T00:00:00Z",
      moved_out_at: "2022-05-01T00:00:00Z",
      address_line_1: "1 Old Street",
      postcode: "AB1 2CD",
      electricity_meter_points: [{ mpan: "1900000000001", is_export: false, meters: [{ serial_number: "OLD0000001" }] }],
      gas_meter_points: [],
    },
    {
      id: 2,
      moved_in_at: "2022-05-01T00:00:00Z",
      moved_out_at: null,
      address_line_1: "2 New Road",
      postcode: "EF3 4GH",
      electricity_meter_points: [
        { mpan: "1200012345678", is_export: false, meters: [{ serial_number: "21l1234567", registers: [] }] },
        { mpan: "1300012345678", is_export: true, meters: [{ serial_number: "21L1234567" }] },
      ],
      gas_meter_points: [{ mprn: "1234567890", meters: [{ serial_number: "E6S12345" }, { serial_number: "G4A12345678" }] }],
    },
  ],
};

// ---------- Todoist ----------

/** Recorded: a bad token (event ids replaced). */
export const TODOIST_UNAUTH = { error: "Invalid token", error_code: 401, error_extra: { access_type: "access_token", event_id: "0000", retry_after: 4 }, error_tag: "AUTH_INVALID_TOKEN", http_code: 401 };

/** 6 Nov 2026 London: a habit-labelled task, a one-off task, and (in the activity) a recurring task's completion. */
export const TODOIST_COMPLETED = {
  items: [
    { id: "t1", task_id: "t1", content: "Stretch", completed_at: "2026-11-06T07:30:00.000000Z", labels: ["habit"], due: null },
    { id: "t2", task_id: "t2", content: "Book the dentist", completed_at: "2026-11-06T12:00:00.000000Z", labels: [], due: null },
  ],
  next_cursor: null,
};
export const TODOIST_ACTIVITIES = {
  results: [
    { object_type: "item", object_id: "r1", event_type: "completed", event_date: "2026-11-06T19:00:00.000000Z", extra_data: { content: "Water the plants", is_recurring: true } },
    { object_type: "item", object_id: "t1", event_type: "completed", event_date: "2026-11-06T07:30:00.000000Z", extra_data: { content: "Stretch" } },
  ],
  next_cursor: null,
};

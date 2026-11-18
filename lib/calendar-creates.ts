/**
 * The events Athena added to a calendar (migration 0048). Undo deletes an
 * event only when it's here and not undone yet: the adapters ask `ledger.has`
 * before they send any DELETE, so nothing else in a calendar can be deleted.
 * Ids only: the title, time and guests stay in the calendar.
 */
import { q } from "./db";

export interface CalendarCreate {
  id: string;
  connector_id: string;
  calendar_id: string;
  event_id: string;
  url: string;
  created_at: string;
  undone_at: string | null;
}

const COLS = "id, connector_id, calendar_id, event_id, url, created_at, undone_at";

export async function recordCreate(row: { connector_id: string; calendar_id: string; event_id: string; url: string }): Promise<CalendarCreate> {
  const [r] = await q<CalendarCreate>(
    `INSERT INTO calendar_creates (connector_id, calendar_id, event_id, url) VALUES ($1, $2, $3, $4)
     ON CONFLICT (connector_id, calendar_id, event_id) DO UPDATE SET url = EXCLUDED.url, undone_at = NULL
     RETURNING ${COLS}`,
    [row.connector_id, row.calendar_id, row.event_id, row.url.slice(0, 2000)],
  );
  return r;
}

export async function getCreate(id: string): Promise<CalendarCreate | null> {
  const [r] = await q<CalendarCreate>(`SELECT ${COLS} FROM calendar_creates WHERE id = $1`, [id]);
  return r ?? null;
}

export async function markUndone(id: string): Promise<void> {
  await q(`UPDATE calendar_creates SET undone_at = now() WHERE id = $1`, [id]);
}

/**
 * What the adapters ask before a delete. Tests swap `has` for their own; the
 * real one reads calendar_creates.
 */
export const ledger = {
  async has(connectorId: string, calendarId: string, eventId: string): Promise<boolean> {
    const rows = await q<{ id: string }>(`SELECT id FROM calendar_creates WHERE connector_id = $1 AND calendar_id = $2 AND event_id = $3 AND undone_at IS NULL`, [connectorId, calendarId, eventId]);
    return rows.length > 0;
  },
};

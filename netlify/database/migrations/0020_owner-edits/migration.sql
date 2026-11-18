-- Athena — fields you changed on a booking or order stay yours.
--
-- `owner_edited` lists the fields you changed by hand ("start_local",
-- "seat", "tracking_number"…; the names in lib/trips.ts BookingFields and
-- PurchaseFields). A later email about the same booking or order updates
-- only the fields not listed here, so a moved flight still comes through
-- unless you changed its time yourself. Field names only, never values.
--
-- A cancellation email always comes through, even on a booking you added:
-- `cancelled_at` and `cancel_email_link` (sealed) say which email did it.
--
-- Additive only. Numbered after 0019 (files). Mirrored at db/schema.sql.

ALTER TABLE trip_bookings ADD COLUMN owner_edited TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE purchases ADD COLUMN owner_edited TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE trip_bookings ADD COLUMN cancelled_at TIMESTAMPTZ;
ALTER TABLE trip_bookings ADD COLUMN cancel_email_link TEXT NOT NULL DEFAULT '';

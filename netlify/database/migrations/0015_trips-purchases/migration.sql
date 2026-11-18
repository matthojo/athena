-- Athena — trips and purchases, from booking and order emails (lib/trips.ts).
--
--  1. trips: a journey, named after where it's to ("Lisbon"). Its dates are
--     worked out from its bookings (the first local day to the last), kept
--     here as plain dates so lists can split upcoming from past in SQL.
--  2. trip_bookings: a flight, train, hotel stay, car hire or event ticket.
--     Instants are UTC (`starts_at`, `ends_at`) and each end keeps the IANA
--     zone of where it happens, so times are shown in the place's own time
--     with its city named. `start_date` / `end_date` are those local days;
--     a booking with no time (a hotel with no check-in hour) has only those.
--     A changed time keeps the old start in `previous_starts_at`.
--  3. purchases: an order (retailer, item names, order number) and where its
--     delivery has got to, with a short timeline in purchase_updates. Never
--     a price, total or card detail: finance is a separate tier (SECURITY.md §1).
--     Settled orders (delivered, returned, refunded, cancelled) are archived by
--     Athena 30 days on; `archived_by_athena` says it was Athena, so a later
--     update can bring it back, and `stay_visible` is set when you restore one,
--     so it isn't archived again.
--  4. The review inbox gains 'booking' and 'purchase', for finds an agent
--     wasn't sure of.
--
-- Free text (titles, names, references, places, links, items) is encrypted at
-- rest like everything else you write (SECURITY.md §11; lib/encryption.ts).
-- Booking references, order numbers and tracking numbers are matched by blind
-- index (HMAC of the normalised value), so an update finds its booking without
-- the value being readable. Dates, times, kinds and statuses stay readable.
--
-- Additive only. Numbered after 0013 (keep in touch) and 0014 (owner time
-- zone), which must be applied first. Mirrored for reference at db/schema.sql.

CREATE TABLE trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,                          -- where it's to: "Lisbon"
  starts_on DATE,                               -- first local day of its bookings
  ends_on DATE,                                 -- last local day
  notes TEXT NOT NULL DEFAULT '',
  source TEXT,                                  -- the collection that started it; null when added by hand
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trips_live_dates_idx ON trips (ends_on, starts_on) WHERE archived_at IS NULL;
CREATE INDEX trips_archived_idx ON trips (archived_at DESC) WHERE archived_at IS NOT NULL;

CREATE TABLE trip_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('flight', 'train', 'hotel', 'car', 'event', 'other')),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'changed', 'cancelled')),
  title TEXT NOT NULL,                          -- "BA 432", "Memmo Alfama", "Fado at Clube de Fado"
  provider TEXT NOT NULL DEFAULT '',            -- "British Airways"
  reference TEXT NOT NULL DEFAULT '',           -- the booking reference
  reference_bidx TEXT,                          -- blind index of the normalised reference
  segment TEXT NOT NULL DEFAULT '',             -- which part of a booking with several: "outbound", "return"
  start_date DATE NOT NULL,                     -- local day it starts (departs, checks in, picks up)
  starts_at TIMESTAMPTZ,                        -- UTC instant, when the time is known
  start_tz TEXT NOT NULL DEFAULT '',            -- IANA zone where it starts
  start_place TEXT NOT NULL DEFAULT '',         -- "London Heathrow, Terminal 5"
  start_city TEXT NOT NULL DEFAULT '',
  end_date DATE,                                -- local day it ends (arrives, checks out, drops off)
  ends_at TIMESTAMPTZ,
  end_tz TEXT NOT NULL DEFAULT '',
  end_place TEXT NOT NULL DEFAULT '',
  end_city TEXT NOT NULL DEFAULT '',
  seat TEXT NOT NULL DEFAULT '',                -- "14A", "Coach 7, seat 61"
  details TEXT NOT NULL DEFAULT '',             -- one short line: room, car class, gate, how many
  email_link TEXT NOT NULL DEFAULT '',          -- the email it came from
  previous_starts_at TIMESTAMPTZ,               -- the start before the last change
  source TEXT,
  source_ref TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trip_bookings_trip_idx ON trip_bookings (trip_id);
CREATE INDEX trip_bookings_reference_idx ON trip_bookings (reference_bidx);
CREATE INDEX trip_bookings_live_starts_idx ON trip_bookings (starts_at) WHERE archived_at IS NULL AND starts_at IS NOT NULL;
CREATE INDEX trip_bookings_archived_idx ON trip_bookings (archived_at DESC) WHERE archived_at IS NOT NULL;

CREATE TABLE purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer TEXT NOT NULL,
  items TEXT[] NOT NULL DEFAULT '{}',           -- item names, each encrypted
  order_number TEXT NOT NULL DEFAULT '',
  order_bidx TEXT,                              -- blind index of the normalised order number
  ordered_on DATE,
  status TEXT NOT NULL DEFAULT 'ordered'
    CHECK (status IN ('ordered', 'dispatched', 'out_for_delivery', 'delivered', 'delayed', 'returned', 'refunded', 'cancelled')),
  status_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- when the current status happened
  expected_on DATE,                             -- the delivery day it's expected, local
  delivered_at TIMESTAMPTZ,
  carrier TEXT NOT NULL DEFAULT '',
  tracking_number TEXT NOT NULL DEFAULT '',
  tracking_bidx TEXT,
  tracking_url TEXT NOT NULL DEFAULT '',
  email_link TEXT NOT NULL DEFAULT '',          -- the order confirmation
  source TEXT,
  source_ref TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  archived_by_athena BOOLEAN NOT NULL DEFAULT false,
  stay_visible BOOLEAN NOT NULL DEFAULT false,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX purchases_order_idx ON purchases (order_bidx);
CREATE INDEX purchases_tracking_idx ON purchases (tracking_bidx);
CREATE INDEX purchases_live_idx ON purchases (status, status_at) WHERE archived_at IS NULL;
CREATE INDEX purchases_archived_idx ON purchases (archived_at DESC) WHERE archived_at IS NOT NULL;

CREATE TABLE purchase_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  status TEXT NOT NULL
    CHECK (status IN ('ordered', 'dispatched', 'out_for_delivery', 'delivered', 'delayed', 'returned', 'refunded', 'cancelled')),
  at TIMESTAMPTZ NOT NULL,
  detail TEXT NOT NULL DEFAULT '',              -- "Left with a neighbour", "New delivery day Thursday"
  email_link TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX purchase_updates_purchase_idx ON purchase_updates (purchase_id, at);

ALTER TABLE suggestions DROP CONSTRAINT suggestions_op_check;
ALTER TABLE suggestions ADD CONSTRAINT suggestions_op_check
  CHECK (op IN ('commitment', 'fact', 'interaction', 'event', 'person', 'link', 'booking', 'purchase'));

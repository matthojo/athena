// TripIt API v1 replies, in the shapes /list/trip/.../include_objects/true/format/json returns (TripIt's v1 object
// types: Trip, AirObject with Segments, LodgingObject, RailObject with Segments, CarObject). TripIt's JSON gives every
// value as a string, and one item as an object rather than a one-item array. No live account was available on 7 Nov 2026.

export const TRIPIT_PROFILE = { timestamp: "1794000000", num_bytes: "512", Profile: { "@attributes": { ref: "abc" }, screen_name: "jordan", public_display_name: "Jordan", is_client: "true" } };

const dt = (date: string, time: string | undefined, timezone: string, utc_offset: string) => ({ date, ...(time ? { time } : {}), timezone, utc_offset });

/** Upcoming: Lisbon, 20 to 23 Nov 2026. Two flights under one reference, a hotel, a car. */
export const TRIPIT_UPCOMING = {
  timestamp: "1794000000",
  num_bytes: "4096",
  page_num: "1",
  page_size: "25",
  max_page: "1",
  Trip: {
    id: "330001",
    display_name: "Lisbon, November 2026",
    start_date: "2026-11-20",
    end_date: "2026-11-23",
    primary_location: "Lisbon, Portugal",
    PrimaryLocationAddress: { address: "Lisbon, Portugal", city: "Lisbon", country: "PT", latitude: "38.7223", longitude: "-9.1393" },
    is_private: "false",
    relative_url: "/trip/show/id/330001",
  },
  AirObject: {
    id: "440001",
    trip_id: "330001",
    display_name: "Flight to Lisbon",
    supplier_name: "TAP Air Portugal",
    supplier_conf_num: "XK7P2Q",
    is_purchased: "true",
    total_cost: "£212.40",
    Segment: [
      {
        id: "550001",
        StartDateTime: dt("2026-11-20", "07:10:00", "Europe/London", "+00:00"),
        EndDateTime: dt("2026-11-20", "09:45:00", "Europe/Lisbon", "+00:00"),
        start_airport_code: "LHR",
        start_city_name: "London",
        start_terminal: "2",
        end_airport_code: "LIS",
        end_city_name: "Lisbon",
        end_terminal: "1",
        marketing_airline: "TAP Air Portugal",
        marketing_airline_code: "TP",
        marketing_flight_number: "1351",
        seats: "22C",
      },
      {
        id: "550002",
        StartDateTime: dt("2026-11-23", "18:30:00", "Europe/Lisbon", "+00:00"),
        EndDateTime: dt("2026-11-23", "21:05:00", "Europe/London", "+00:00"),
        start_airport_code: "LIS",
        start_city_name: "Lisbon",
        end_airport_code: "LHR",
        end_city_name: "London",
        marketing_airline: "TAP Air Portugal",
        marketing_airline_code: "TP",
        marketing_flight_number: "1358",
      },
    ],
  },
  LodgingObject: {
    id: "440002",
    trip_id: "330001",
    display_name: "Memmo Alfama",
    supplier_name: "Memmo Alfama",
    supplier_conf_num: "HTL998",
    booking_site_name: "Booking.com",
    StartDateTime: dt("2026-11-20", "15:00:00", "Europe/Lisbon", "+00:00"),
    EndDateTime: dt("2026-11-23", "11:00:00", "Europe/Lisbon", "+00:00"),
    Address: { address: "Travessa das Merceeiras 27, Lisbon", city: "Lisbon", country: "PT" },
    total_cost: "€540.00",
  },
  CarObject: {
    id: "440003",
    trip_id: "330001",
    supplier_name: "Hertz",
    StartDateTime: dt("2026-11-21", "09:00:00", "Europe/Lisbon", "+00:00"),
    EndDateTime: dt("2026-11-22", "18:00:00", "Europe/Lisbon", "+00:00"),
    start_location_name: "Lisbon Airport",
    StartLocationAddress: { city: "Lisbon" },
    end_location_name: "Lisbon Airport",
    car_type: "Compact",
  },
};

/** Past, newest first: Paris by train (ended 2 Nov, within 30 days), then Rome in May (too old to read back). */
export const TRIPIT_PAST = {
  timestamp: "1794000000",
  page_num: "1",
  page_size: "25",
  max_page: "1",
  Trip: [
    { id: "330002", display_name: "Paris", start_date: "2026-10-30", end_date: "2026-11-02", primary_location: "Paris, France", PrimaryLocationAddress: { city: "Paris" } },
    { id: "330003", display_name: "Rome", start_date: "2026-05-10", end_date: "2026-05-14", primary_location: "Rome, Italy" },
  ],
  RailObject: [
    {
      id: "440010",
      trip_id: "330002",
      supplier_name: "Eurostar",
      supplier_conf_num: "EUR42Z",
      Segment: {
        id: "550010",
        StartDateTime: dt("2026-10-30", "08:01:00", "Europe/London", "+00:00"),
        EndDateTime: dt("2026-10-30", "11:20:00", "Europe/Paris", "+01:00"),
        start_station_name: "London St Pancras International",
        StartStationAddress: { city: "London" },
        end_station_name: "Paris Gare du Nord",
        EndStationAddress: { city: "Paris" },
        carrier_name: "Eurostar",
        train_number: "9014",
        coach_number: "7",
        seats: "61",
      },
    },
    {
      id: "440011",
      trip_id: "330003",
      supplier_name: "Trenitalia",
      Segment: { id: "550011", StartDateTime: dt("2026-05-12", "09:00:00", "Europe/Rome", "+02:00"), start_station_name: "Roma Termini", carrier_name: "Trenitalia", train_number: "9512" },
    },
  ],
};

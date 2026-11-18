/**
 * Airports and airlines for live flight times. Pure (no Node or DOM), so the
 * server and the app read the same table.
 *
 *  - Airports: IATA and ICAO codes, where they are (for OpenSky's box around
 *    an airport) and the names booking emails use ("Heathrow T5", "Lisbon
 *    Airport T1", "LIS"). Hand-made and compact: the UK's airports and the
 *    places people from here fly to most. A name that isn't here maps to
 *    nothing, and the booking shows "Live times unavailable".
 *  - Airlines: IATA → ICAO designator. OpenSky knows a flight by its
 *    callsign, which for most airlines is the ICAO designator and the flight
 *    number ("BA 432" flies as BAW432). Some airlines fly under other
 *    callsigns (easyJet's are often letters: EZY52KP), and then OpenSky can't
 *    match.
 */

export interface Airport {
  iata: string;
  icao: string;
  /** "Heathrow", as the strip says it. */
  name: string;
  city: string;
  lat: number;
  lon: number;
}

// IATA ICAO lat lon | name | city | other names
const AIRPORT_TABLE = `LHR EGLL 51.4700 -0.4543|Heathrow|London|london heathrow
LGW EGKK 51.1537 -0.1821|Gatwick|London|london gatwick
STN EGSS 51.8860 0.2389|Stansted|London|london stansted
LTN EGGW 51.8747 -0.3683|Luton|London|london luton
LCY EGLC 51.5048 0.0495|London City|London|city airport
SEN EGMC 51.5714 0.6956|Southend|London|london southend
BRS EGGD 51.3827 -2.7191|Bristol|Bristol|bristol airport
BHX EGBB 52.4539 -1.7480|Birmingham|Birmingham|birmingham airport
MAN EGCC 53.3537 -2.2750|Manchester|Manchester|manchester airport
LPL EGGP 53.3336 -2.8497|Liverpool|Liverpool|john lennon
LBA EGNM 53.8659 -1.6606|Leeds Bradford|Leeds|
NCL EGNT 55.0375 -1.6917|Newcastle|Newcastle|
EMA EGNX 52.8311 -1.3281|East Midlands|Nottingham|
EDI EGPH 55.9500 -3.3725|Edinburgh|Edinburgh|edinburgh airport
GLA EGPF 55.8719 -4.4331|Glasgow|Glasgow|glasgow airport
ABZ EGPD 57.2019 -2.1978|Aberdeen|Aberdeen|
INV EGPE 57.5425 -4.0475|Inverness|Inverness|
BFS EGAA 54.6575 -6.2158|Belfast International|Belfast|
BHD EGAC 54.6181 -5.8725|Belfast City|Belfast|george best
CWL EGFF 51.3967 -3.3433|Cardiff|Cardiff|
SOU EGHI 50.9503 -1.3568|Southampton|Southampton|
EXT EGTE 50.7344 -3.4139|Exeter|Exeter|
NQY EGHQ 50.4406 -4.9954|Newquay|Newquay|cornwall airport
JER EGJJ 49.2079 -2.1955|Jersey|Jersey|
GCI EGJB 49.4350 -2.6020|Guernsey|Guernsey|
IOM EGNS 54.0833 -4.6239|Isle of Man|Douglas|ronaldsway
DUB EIDW 53.4213 -6.2701|Dublin|Dublin|
ORK EICK 51.8413 -8.4911|Cork|Cork|
SNN EINN 52.7020 -8.9248|Shannon|Shannon|
LIS LPPT 38.7742 -9.1342|Lisbon|Lisbon|humberto delgado|lisboa
OPO LPPR 41.2481 -8.6814|Porto|Porto|francisco sa carneiro
FAO LPFR 37.0144 -7.9659|Faro|Faro|
FNC LPMA 32.6979 -16.7745|Madeira|Funchal|funchal
MAD LEMD 40.4719 -3.5626|Madrid|Madrid|barajas
BCN LEBL 41.2971 2.0785|Barcelona|Barcelona|el prat
AGP LEMG 36.6749 -4.4991|Malaga|Malaga|málaga
ALC LEAL 38.2822 -0.5582|Alicante|Alicante|
PMI LEPA 39.5517 2.7388|Palma|Palma|mallorca|majorca
IBZ LEIB 38.8729 1.3731|Ibiza|Ibiza|
SVQ LEZL 37.4180 -5.8931|Seville|Seville|sevilla
VLC LEVC 39.4893 -0.4816|Valencia|Valencia|
TFS GCTS 28.0445 -16.5725|Tenerife South|Tenerife|
LPA GCLP 27.9319 -15.3866|Gran Canaria|Las Palmas|
ACE GCRR 28.9455 -13.6052|Lanzarote|Lanzarote|arrecife
CDG LFPG 49.0097 2.5479|Paris Charles de Gaulle|Paris|charles de gaulle|roissy
ORY LFPO 48.7262 2.3652|Paris Orly|Paris|orly
NCE LFMN 43.6584 7.2159|Nice|Nice|cote d'azur
LYS LFLL 45.7256 5.0811|Lyon|Lyon|saint exupery
GVA LSGG 46.2381 6.1090|Geneva|Geneva|genève
ZRH LSZH 47.4647 8.5492|Zurich|Zurich|zürich
BSL LFSB 47.5896 7.5299|Basel|Basel|euroairport
AMS EHAM 52.3086 4.7639|Amsterdam|Amsterdam|schiphol
BRU EBBR 50.9014 4.4844|Brussels|Brussels|zaventem
FRA EDDF 50.0333 8.5706|Frankfurt|Frankfurt|
MUC EDDM 48.3538 11.7861|Munich|Munich|münchen
BER EDDB 52.3667 13.5033|Berlin|Berlin|brandenburg
HAM EDDH 53.6304 9.9882|Hamburg|Hamburg|
DUS EDDL 51.2895 6.7668|Düsseldorf|Dusseldorf|dusseldorf
CPH EKCH 55.6180 12.6560|Copenhagen|Copenhagen|kastrup
ARN ESSA 59.6519 17.9186|Stockholm Arlanda|Stockholm|arlanda
OSL ENGM 60.1939 11.1004|Oslo|Oslo|gardermoen
HEL EFHK 60.3172 24.9633|Helsinki|Helsinki|vantaa
KEF BIKF 63.9850 -22.6056|Reykjavík|Reykjavik|keflavik
FCO LIRF 41.8003 12.2389|Rome Fiumicino|Rome|fiumicino|leonardo da vinci
MXP LIMC 45.6306 8.7281|Milan Malpensa|Milan|malpensa
LIN LIML 45.4451 9.2767|Milan Linate|Milan|linate
VCE LIPZ 45.5053 12.3519|Venice|Venice|marco polo
NAP LIRN 40.8860 14.2908|Naples|Naples|
PSA LIRP 43.6839 10.3927|Pisa|Pisa|galileo galilei
CTA LICC 37.4668 15.0664|Catania|Catania|
VIE LOWW 48.1103 16.5697|Vienna|Vienna|schwechat
PRG LKPR 50.1008 14.2600|Prague|Prague|václav havel
BUD LHBP 47.4298 19.2611|Budapest|Budapest|
WAW EPWA 52.1657 20.9671|Warsaw|Warsaw|chopin
KRK EPKK 50.0777 19.7848|Kraków|Krakow|krakow
ATH LGAV 37.9364 23.9445|Athens|Athens|
HER LGIR 35.3397 25.1803|Heraklion|Crete|
SPU LDSP 43.5389 16.2980|Split|Split|
DBV LDDU 42.5614 18.2682|Dubrovnik|Dubrovnik|
MLA LMML 35.8575 14.4775|Malta|Valletta|luqa
LCA LCLK 34.8751 33.6249|Larnaca|Larnaca|
PFO LCPH 34.7180 32.4857|Paphos|Paphos|
IST LTFM 41.2753 28.7519|Istanbul|Istanbul|
DXB OMDB 25.2532 55.3657|Dubai|Dubai|
DOH OTHH 25.2731 51.6081|Doha|Doha|hamad
JFK KJFK 40.6413 -73.7781|New York JFK|New York|kennedy
EWR KEWR 40.6895 -74.1745|Newark|New York|newark liberty
BOS KBOS 42.3656 -71.0096|Boston|Boston|logan
IAD KIAD 38.9531 -77.4565|Washington Dulles|Washington|dulles
ORD KORD 41.9742 -87.9073|Chicago O'Hare|Chicago|ohare
LAX KLAX 33.9416 -118.4085|Los Angeles|Los Angeles|
SFO KSFO 37.6213 -122.3790|San Francisco|San Francisco|
YYZ CYYZ 43.6777 -79.6248|Toronto|Toronto|pearson
SIN WSSS 1.3644 103.9915|Singapore|Singapore|changi
HKG VHHH 22.3080 113.9185|Hong Kong|Hong Kong|
NRT RJAA 35.7720 140.3929|Tokyo Narita|Tokyo|narita
HND RJTT 35.5494 139.7798|Tokyo Haneda|Tokyo|haneda`;

const AIRPORTS: Airport[] = [];
const BY_IATA = new Map<string, Airport>();
const BY_ICAO = new Map<string, Airport>();
/** Every name and alias, normalised, to its airport. */
const BY_NAME = new Map<string, Airport>();
/** A city with one airport (or one main one: the first listed), to it. */
const BY_CITY = new Map<string, Airport>();

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(international|intl|airport|aeroporto|aeropuerto|aeroport|flughafen|terminal|t\d)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

for (const row of AIRPORT_TABLE.split("\n")) {
  const [head, name, city, ...aliases] = row.split("|");
  const [iata, icao, lat, lon] = head.trim().split(/\s+/);
  const a: Airport = { iata, icao, name, city, lat: Number(lat), lon: Number(lon) };
  AIRPORTS.push(a);
  BY_IATA.set(iata, a);
  BY_ICAO.set(icao, a);
  for (const n of [name, ...aliases].filter(Boolean)) BY_NAME.set(norm(n), a);
  // Heathrow is London's main airport; Belfast International, Belfast's.
  if (!BY_CITY.has(norm(city))) BY_CITY.set(norm(city), a);
}

export const airportByIata = (code: string): Airport | null => BY_IATA.get(code.trim().toUpperCase()) ?? null;
export const airportByIcao = (code: string): Airport | null => BY_ICAO.get(code.trim().toUpperCase()) ?? null;

/**
 * The airport a booking's place (then city) names, or null. Tries, in order:
 * a code in brackets or on its own ("(LIS)", "LHR", "EGLL"), the whole name
 * ("Heathrow T5", "Lisbon Airport T1"), then the city ("Lisbon").
 */
export function airportFor(place: string | null | undefined, city?: string | null): Airport | null {
  for (const raw of [place, city]) {
    if (!raw?.trim()) continue;
    const bracket = /[([]\s*([A-Z]{3,4})\s*[)\]]/.exec(raw)?.[1];
    if (bracket) {
      const hit = bracket.length === 3 ? airportByIata(bracket) : airportByIcao(bracket);
      if (hit) return hit;
    }
    const bare = raw.trim();
    if (/^[A-Z]{3}$/.test(bare) && airportByIata(bare)) return airportByIata(bare);
    if (/^[A-Z]{4}$/.test(bare) && airportByIcao(bare)) return airportByIcao(bare);
    const key = norm(raw);
    if (!key) continue;
    const named = BY_NAME.get(key) ?? BY_CITY.get(key);
    if (named) return named;
    // "London Heathrow Terminal 5 (Departures)": the first known name inside it.
    for (const [n, a] of BY_NAME) if (n.length > 3 && ` ${key} `.includes(` ${n} `)) return a;
  }
  return null;
}

/** The terminal a booking's place names: "Heathrow T5" → "5", "Lisbon Airport Terminal 1" → "1". */
export function terminalIn(place: string | null | undefined): string | null {
  const m = /\b(?:T|Terminal\s*)(\d{1,2}[A-Z]?|North|South)\b/i.exec(place ?? "");
  return m ? m[1].replace(/^(north|south)$/i, (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()) : null;
}

// ---------- airlines ----------

/** IATA → ICAO designator, for OpenSky's callsigns. */
export const AIRLINE_ICAO: Readonly<Record<string, string>> = {
  BA: "BAW", VS: "VIR", U2: "EZY", EC: "EJU", DS: "EZS", FR: "RYR", RK: "RUK", LS: "EXS", BY: "TOM", W6: "WZZ", W9: "WUK",
  EI: "EIN", EW: "EWG", LH: "DLH", LX: "SWR", OS: "AUA", SN: "BEL", AF: "AFR", KL: "KLM", IB: "IBE", VY: "VLG", UX: "AEA",
  TP: "TAP", AZ: "ITY", SK: "SAS", AY: "FIN", DY: "NOZ", D8: "NSZ", FI: "ICE", LO: "LOT", A3: "AEE", TK: "THY", PC: "PGT",
  EK: "UAE", QR: "QTR", EY: "ETD", AA: "AAL", UA: "UAL", DL: "DAL", AC: "ACA", WS: "WJA", B6: "JBU", SQ: "SIA", CX: "CPA",
  JL: "JAL", NH: "ANA", QF: "QFA", LM: "LOG", T3: "EZE", BE: "BEE", "2L": "OAW", HV: "TRA", TO: "TVF", V7: "VOE", JU: "ASL",
};

export interface FlightNumber {
  /** "BA" */
  airline: string;
  /** "432" (leading zeros dropped, a letter suffix kept) */
  number: string;
  /** "BA 432", as the strip says it. */
  label: string;
  /** "BA432", as schedule APIs take it. */
  compact: string;
}

const FLIGHT = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?-?(\d{1,4}[A-Z]?)\b/;

/** The flight number in a booking's title (then its details): "BA 432", "Flight EZY8001" (ICAO), "U2 8001". Null when there's none. */
export function flightNumberIn(...texts: Array<string | null | undefined>): FlightNumber | null {
  for (const t of texts) {
    const text = (t ?? "").toUpperCase();
    // An ICAO designator written out ("BAW432", "EZY8001"): back to IATA.
    const icao = /\b([A-Z]{3})\s?(\d{1,4}[A-Z]?)\b/.exec(text);
    if (icao) {
      const iata = Object.entries(AIRLINE_ICAO).find(([, v]) => v === icao[1])?.[0];
      if (iata) return make(iata, icao[2]);
    }
    const m = FLIGHT.exec(text);
    if (m && !/^\d+$/.test(m[1])) return make(m[1], m[2]);
  }
  return null;
}

function make(airline: string, raw: string): FlightNumber {
  const number = raw.replace(/^0+(?=\d)/, "");
  return { airline, number, label: `${airline} ${number}`, compact: `${airline}${number}` };
}

/** "BAW432", the callsign OpenSky sees, or null for an airline not in the table. */
export function callsignFor(f: FlightNumber): string | null {
  const icao = AIRLINE_ICAO[f.airline];
  return icao ? `${icao}${f.number}` : null;
}

/** For tests. */
export const AIRPORT_COUNT = (): number => AIRPORTS.length;

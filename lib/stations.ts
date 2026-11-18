/**
 * Stations: National Rail CRS codes for the names booking emails use, and
 * which TfL lines serve the London stations in a journey history. Pure (no
 * Node or DOM), so the server (live times, the briefing, Ask) and the app
 * read the same table.
 *
 * The CRS table is hand-made and compact: the GB stations a booking is likely
 * to start or end at (London termini and big London stops, every city and
 * most large towns, the airports with a station). A name that isn't here, or
 * that could be several places ("London Terminals", "London"), maps to
 * nothing, and the booking simply shows no live times.
 *
 * Matching (crsFor), most certain first:
 *   1. a code in brackets, "Bristol Temple Meads [BRI]";
 *   2. the whole name, ignoring case, punctuation, "station" and "London"
 *      ("LONDON PADDINGTON", "Paddington", "Kings X");
 *   3. a bare code ("PAD", "pad");
 *   4. a city on its own, to its main station ("Birmingham" is New Street);
 *   5. the words given are all in exactly one station's name
 *      ("Temple Meads", "Newport" for Newport (South Wales));
 *   6. one or two letters out, for a name a hand typed ("Paddingon").
 */

// ---------- National Rail ----------

/** Code and name, as National Rail names the station. */
const CRS_TABLE = `PAD London Paddington|EUS London Euston|KGX London King's Cross|STP London St Pancras International|LST London Liverpool Street
|VIC London Victoria|WAT London Waterloo|WAE London Waterloo East|CHX London Charing Cross|CST London Cannon Street|LBG London Bridge
|FST London Fenchurch Street|MYB London Marylebone|BFR London Blackfriars|CTK City Thameslink|ZFD Farringdon|MOG Moorgate|OLD Old Street
|CLJ Clapham Junction|SRA Stratford (London)|SFA Stratford International|EAL Ealing Broadway|WIM Wimbledon|VXH Vauxhall|RMD Richmond (London)
|SUR Surbiton|ECR East Croydon|WCY West Croydon|HHY Highbury & Islington|FPK Finsbury Park|TOM Tottenham Hale|ZCW Canada Water
|ZLW Whitechapel|ABW Abbey Wood|LEW Lewisham|GNW Greenwich|HKC Hackney Central|HAC Hackney Downs|WIJ Willesden Junction
|SPB Shepherd's Bush|KPA Kensington Olympia|WHP West Hampstead Thameslink|KTN Kentish Town|HRW Harrow & Wealdstone|WMB Wembley Central
|RMF Romford|SNF Shenfield|TCR Tottenham Court Road|BDS Bond Street|CWX Canary Wharf|WWC Woolwich|PMR Peckham Rye|DMK Denmark Hill
|BRX Brixton|HNH Herne Hill|BAL Balham|NXG New Cross Gate|PUT Putney|TWI Twickenham|KNG Kingston|BMS Bromley South|ORP Orpington
|DFD Dartford|GRV Gravesend|EBD Ebbsfleet International|BKG Barking|UPM Upminster|WEH West Ham|IFD Ilford|SVS Seven Sisters
|WHC Walthamstow Central|ENF Enfield Town|HAY Hayes & Harlington|WDT West Drayton|STL Southall|SUO Sutton (Surrey)|EPH Elephant & Castle
|HXX Heathrow Terminals 2 & 3|HWV Heathrow Terminal 5|HAF Heathrow Terminal 4|GTW Gatwick Airport|SSD Stansted Airport
|LTN Luton Airport Parkway|SIA Southend Airport|SOV Southend Victoria|SOC Southend Central
|RDG Reading|SLO Slough|MAI Maidenhead|TWY Twyford|DID Didcot Parkway|OXF Oxford|OXP Oxford Parkway|BIV Bicester Village|BCS Bicester North
|HWY High Wycombe|AYS Aylesbury|BAN Banbury|LMS Leamington Spa|WRW Warwick|SAV Stratford-upon-Avon|NBY Newbury|SWI Swindon
|CPM Chippenham|BTH Bath Spa|BRI Bristol Temple Meads|BPW Bristol Parkway|WSM Weston-super-Mare|TAU Taunton|CLC Castle Cary
|WSB Westbury|EXD Exeter St Davids|EXC Exeter Central|NTA Newton Abbot|TOT Totnes|PGN Paignton|TQY Torquay|PLY Plymouth|TRU Truro
|PNZ Penzance|SIV St Ives|NQY Newquay|BNP Barnstaple|GCR Gloucester|CNM Cheltenham Spa|STD Stroud|KEM Kemble|WOF Worcester Foregate Street
|WOS Worcester Shrub Hill|HFD Hereford|CDF Cardiff Central|CDQ Cardiff Queen Street|NWP Newport (South Wales)|SWA Swansea|CMN Carmarthen
|AYW Aberystwyth|SHR Shrewsbury|BNG Bangor (Gwynedd)|HHD Holyhead|LLJ Llandudno Junction|CTR Chester
|BHM Birmingham New Street|BMO Birmingham Moor Street|BSW Birmingham Snow Hill|BHI Birmingham International|COV Coventry|WVH Wolverhampton
|SOT Stoke-on-Trent|CRE Crewe|MKC Milton Keynes Central|BLY Bletchley|NMP Northampton|RUG Rugby|NUN Nuneaton|TAM Tamworth|LIC Lichfield Trent Valley
|SAF Stafford|WFJ Watford Junction|HML Hemel Hempstead|BDM Bedford|LUT Luton|SAC St Albans City|HIT Hitchin|SVG Stevenage|WGC Welwyn Garden City
|PBO Peterborough|GRA Grantham|NNG Newark Northgate|LCN Lincoln|DON Doncaster|RET Retford|YRK York|LDS Leeds|WKF Wakefield Westgate|HUD Huddersfield
|BDI Bradford Interchange|BDQ Bradford Forster Square|HGT Harrogate|SHF Sheffield|CHD Chesterfield|DBY Derby|NOT Nottingham|LEI Leicester
|LBO Loughborough|KET Kettering|WEL Wellingborough|MHR Market Harborough|HUL Hull|SCA Scarborough|DAR Darlington|DHM Durham|NCL Newcastle
|SUN Sunderland|MBR Middlesbrough|ALM Alnmouth|BWK Berwick-upon-Tweed|MAN Manchester Piccadilly|MCV Manchester Victoria|MCO Manchester Oxford Road
|MIA Manchester Airport|SPT Stockport|MAC Macclesfield|WML Wilmslow|BON Bolton|WGN Wigan North Western|WBQ Warrington Bank Quay|RUN Runcorn
|LIV Liverpool Lime Street|LPY Liverpool South Parkway|SOP Southport|PRE Preston|BPN Blackpool North|LAN Lancaster|OXN Oxenholme Lake District
|PNR Penrith North Lakes|CAR Carlisle|EDB Edinburgh|HYM Haymarket|GLC Glasgow Central|GLQ Glasgow Queen Street|STG Stirling|PTH Perth
|DEE Dundee|ABD Aberdeen|INV Inverness|FTW Fort William|KDY Kirkcaldy|FKK Falkirk High|MTH Motherwell|PYG Paisley Gilmour Street|AYR Ayr
|CBG Cambridge|CMB Cambridge North|ELY Ely|KLN King's Lynn|NRW Norwich|IPS Ipswich|COL Colchester|CHM Chelmsford|BSE Bury St Edmunds|LWT Lowestoft
|HWN Harlow Town|BIS Bishop's Stortford|BTN Brighton|HOV Hove|HHE Haywards Heath|TBD Three Bridges|CRW Crawley|HRH Horsham|LWS Lewes
|EBN Eastbourne|HGS Hastings|WRH Worthing|CCH Chichester|GLD Guildford|WOK Woking|BSK Basingstoke|WIN Winchester|SOU Southampton Central
|SOA Southampton Airport Parkway|BMH Bournemouth|POO Poole|WEY Weymouth|SAL Salisbury|ADV Andover|FTM Fareham|HAV Havant
|PMH Portsmouth Harbour|PMS Portsmouth & Southsea|RDH Redhill|REI Reigate|DKG Dorking|EPS Epsom|CBW Canterbury West|CBE Canterbury East
|AFK Ashford International|DVP Dover Priory|FKC Folkestone Central|MAR Margate|RAM Ramsgate|TON Tonbridge|TBW Tunbridge Wells|SEV Sevenoaks
|MDE Maidstone East|RTR Rochester|CTM Chatham|WNC Windsor & Eton Central|WNR Windsor & Eton Riverside|HOT Henley-on-Thames`;

/** Other names booking emails and people use for a station, by code. */
const ALIASES: Record<string, string[]> = {
  STP: ["St Pancras", "London St Pancras", "St Pancras International"],
  EDB: ["Edinburgh Waverley"],
  HYM: ["Edinburgh Haymarket"],
  HXX: ["Heathrow Airport", "Heathrow Terminal 2", "Heathrow Terminal 3", "Heathrow Central"],
  SRA: ["Stratford"],
  RMD: ["Richmond"],
  NCL: ["Newcastle Central"],
  SOT: ["Stoke"],
  MKC: ["Milton Keynes"],
  LIV: ["Liverpool"],
  CBW: ["Canterbury"],
  OXN: ["Oxenholme"],
  PNR: ["Penrith"],
};

/** A city on its own means its main station. */
const CITY: Record<string, string> = {
  birmingham: "BHM",
  manchester: "MAN",
  glasgow: "GLC",
  edinburgh: "EDB",
  liverpool: "LIV",
  bristol: "BRI",
  cardiff: "CDF",
  exeter: "EXD",
  southampton: "SOU",
  portsmouth: "PMS",
  bradford: "BDI",
  worcester: "WOF",
  heathrow: "HXX",
  gatwick: "GTW",
  stansted: "SSD",
};

/** Names that are several stations at once: never a guess. */
const NOT_ONE = new Set(["london", "london terminals", "london termini", "london all", "any london", "london zones 1 6"]);

/** A station name reduced to the words that tell it apart. */
export function stationKey(raw: string): string {
  return ` ${raw.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")} `
    .replace(/&/g, " and ")
    .replace(/['’`.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/ saint /g, " st ")
    .replace(/ street /g, " st ")
    .replace(/ (?:intl|int) /g, " international ")
    .replace(/ x /g, " cross ")
    .replace(/ bham /g, " birmingham ")
    .replace(/ (?:pkwy|pky) /g, " parkway ")
    .replace(/ (?:jn|jct|jcn) /g, " junction ")
    .replace(/ rd /g, " road ")
    .replace(/ (?:rail|railway|train|trains|station|stn|national rail|mainline|nr) /g, " ")
    .replace(/ (?:rail|railway|station|stn) /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const withoutLondon = (k: string) => k.replace(/^london /, "");

interface Station {
  crs: string;
  name: string;
  key: string;
  short: string;
  words: string[];
}

let stations: Station[] | null = null;
let byKey: Map<string, string> | null = null;

/** Built the first time it's asked for, not on import. */
function table(): { list: Station[]; keys: Map<string, string> } {
  if (!stations || !byKey) {
    const list: Station[] = [];
    const keys = new Map<string, string>();
    for (const part of CRS_TABLE.split("|")) {
      const m = /^\s*([A-Z]{3}) (.+?)\s*$/.exec(part);
      if (!m) continue;
      const key = stationKey(m[2]);
      list.push({ crs: m[1], name: m[2], key, short: withoutLondon(key), words: withoutLondon(key).split(" ") });
      keys.set(key, m[1]);
      if (!keys.has(withoutLondon(key))) keys.set(withoutLondon(key), m[1]);
    }
    for (const [crs, names] of Object.entries(ALIASES)) for (const n of names) keys.set(stationKey(n), crs);
    stations = list;
    byKey = keys;
  }
  return { list: stations, keys: byKey };
}

/** National Rail's name for a code: "London Paddington". Null for a code that isn't in the table. */
export function stationName(crs: string): string | null {
  const code = crs.trim().toUpperCase();
  return table().list.find((s) => s.crs === code)?.name ?? null;
}

/** How many single-letter edits turn a into b (stops counting past `max`). */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The CRS code for a station name as an email or a person writes it, or null when it isn't one station we know. */
export function crsFor(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text || text.length > 120) return null;
  const { list, keys } = table();
  const known = (code: string) => list.some((s) => s.crs === code);

  // 1. "Bristol Temple Meads [BRI]", "Manchester Piccadilly (MAN)".
  const bracketed = /[([]\s*([A-Za-z]{3})\s*[)\]]/.exec(text);
  if (bracketed && known(bracketed[1].toUpperCase())) return bracketed[1].toUpperCase();

  const key = stationKey(text);
  if (!key || NOT_ONE.has(key)) return null;

  // 2. The whole name, with or without "London".
  const exact = keys.get(key) ?? keys.get(withoutLondon(key));
  if (exact) return exact;

  // 3. A bare code.
  if (/^[a-z]{3}$/.test(key) && known(key.toUpperCase())) return key.toUpperCase();

  // 4. A city on its own.
  if (CITY[withoutLondon(key)]) return CITY[withoutLondon(key)];

  // 5. Every word given is in exactly one station's name.
  const words = withoutLondon(key).split(" ").filter(Boolean);
  if (words.length && words.join("").length >= 3) {
    const hits = list.filter((s) => words.every((w) => s.words.includes(w)));
    if (hits.length === 1) return hits[0].crs;
    if (hits.length > 1) return null;
  }

  // 6. A letter or two out, on a name long enough for that to be safe.
  const short = withoutLondon(key);
  if (short.length >= 6) {
    const max = short.length >= 10 ? 2 : 1;
    let best: { crs: string; d: number } | null = null;
    let tie = false;
    for (const s of list) {
      const d = Math.min(editDistance(short, s.short, max), editDistance(key, s.key, max));
      if (d > max) continue;
      if (!best || d < best.d) {
        best = { crs: s.crs, d };
        tie = false;
      } else if (d === best.d && s.crs !== best.crs) tie = true;
    }
    if (best && !tie) return best.crs;
  }
  return null;
}

// ---------- TfL lines ----------

/** TfL line ids, with the name the briefing says. */
export const TFL_LINES: Record<string, string> = {
  bakerloo: "Bakerloo line",
  central: "Central line",
  circle: "Circle line",
  district: "District line",
  "hammersmith-city": "Hammersmith & City line",
  jubilee: "Jubilee line",
  metropolitan: "Metropolitan line",
  northern: "Northern line",
  piccadilly: "Piccadilly line",
  victoria: "Victoria line",
  "waterloo-city": "Waterloo & City line",
  elizabeth: "Elizabeth line",
  dlr: "DLR",
  liberty: "Liberty line",
  lioness: "Lioness line",
  mildmay: "Mildmay line",
  suffragette: "Suffragette line",
  weaver: "Weaver line",
  windrush: "Windrush line",
};

/** The lines at London's busier stations, by the name a TfL journey history uses. */
const TFL_STATIONS = `Oxford Circus=bakerloo central victoria|Bank=central northern waterloo-city dlr|Monument=circle district
|King's Cross St Pancras=circle hammersmith-city metropolitan northern piccadilly victoria
|Liverpool Street=central circle hammersmith-city metropolitan elizabeth weaver|Paddington=bakerloo circle district hammersmith-city elizabeth
|Victoria=circle district victoria|Waterloo=bakerloo jubilee northern waterloo-city|London Bridge=jubilee northern
|Canary Wharf=jubilee elizabeth dlr|Stratford=central jubilee elizabeth dlr mildmay|Westminster=circle district jubilee
|Green Park=jubilee piccadilly victoria|Bond Street=central jubilee elizabeth|Tottenham Court Road=central northern elizabeth
|Leicester Square=northern piccadilly|Piccadilly Circus=bakerloo piccadilly|Holborn=central piccadilly|Euston=northern victoria lioness
|Euston Square=circle hammersmith-city metropolitan|Old Street=northern|Angel=northern|Moorgate=circle hammersmith-city metropolitan northern
|Farringdon=circle hammersmith-city metropolitan elizabeth|Barbican=circle hammersmith-city metropolitan|St Paul's=central|Chancery Lane=central
|Tower Hill=circle district|Embankment=bakerloo circle district northern|Charing Cross=bakerloo northern
|Baker Street=bakerloo circle hammersmith-city jubilee metropolitan|Highbury & Islington=victoria mildmay windrush|Finsbury Park=piccadilly victoria
|Camden Town=northern|Brixton=victoria|Stockwell=northern victoria|Vauxhall=victoria|Clapham Common=northern|Clapham North=northern
|Clapham South=northern|Clapham Junction=mildmay windrush|Shepherd's Bush=central mildmay|Notting Hill Gate=central circle district
|Earl's Court=district piccadilly|South Kensington=circle district piccadilly|Hammersmith=circle district hammersmith-city piccadilly
|Whitechapel=district hammersmith-city elizabeth windrush|Mile End=central district hammersmith-city|Bethnal Green=central weaver
|Canada Water=jubilee windrush|Shoreditch High Street=windrush|Hoxton=windrush|Haggerston=windrush|Dalston Junction=windrush
|Dalston Kingsland=mildmay|Hackney Central=mildmay|Hackney Wick=mildmay|Homerton=mildmay|Canonbury=mildmay windrush|West Hampstead=jubilee mildmay
|Kentish Town=northern|Archway=northern|Highgate=northern|Seven Sisters=victoria weaver|Walthamstow Central=victoria weaver|Tottenham Hale=victoria
|Wimbledon=district|Richmond=district mildmay|Ealing Broadway=central district elizabeth|Acton Town=district piccadilly
|Heathrow Terminals 2 & 3=piccadilly elizabeth|Heathrow Terminal 5=piccadilly elizabeth|Woolwich=elizabeth|Abbey Wood=elizabeth
|Custom House=elizabeth dlr|West Ham=district hammersmith-city jubilee dlr|Canning Town=jubilee dlr|North Greenwich=jubilee
|Elephant & Castle=bakerloo northern|Borough=northern|Southwark=jubilee|Bermondsey=jubilee|Marble Arch=central|Lancaster Gate=central
|Queensway=central|Holland Park=central|White City=central|Wood Lane=circle hammersmith-city|Russell Square=piccadilly|Covent Garden=piccadilly
|Knightsbridge=piccadilly|Hyde Park Corner=piccadilly|Sloane Square=circle district|Gloucester Road=circle district piccadilly
|High Street Kensington=circle district|Edgware Road=bakerloo circle district hammersmith-city|Marylebone=bakerloo|Regent's Park=bakerloo
|Warren Street=northern victoria|Goodge Street=northern|Mornington Crescent=northern|Kennington=northern|Oval=northern|Pimlico=victoria
|St James's Park=circle district|Temple=circle district|Blackfriars=circle district|Mansion House=circle district|Cannon Street=circle district
|Aldgate=circle metropolitan|Aldgate East=district hammersmith-city|Shadwell=dlr windrush|Limehouse=dlr|Cutty Sark=dlr|Lewisham=dlr
|Stratford International=dlr|Wembley Park=jubilee metropolitan|Willesden Green=jubilee|Kilburn=jubilee|Swiss Cottage=jubilee
|Finchley Road=jubilee metropolitan|Golders Green=northern|Hampstead=northern|East Finchley=northern|Morden=northern|Tooting Broadway=northern
|Tooting Bec=northern|Balham=northern|Putney Bridge=district|Fulham Broadway=district|Parsons Green=district|Turnham Green=district piccadilly
|Chiswick Park=district|Gunnersbury=district mildmay|Kew Gardens=district mildmay|Leyton=central|Leytonstone=central|Harrow-on-the-Hill=metropolitan
|Uxbridge=metropolitan piccadilly|Romford=elizabeth liberty|Shenfield=elizabeth|Ilford=elizabeth|Forest Gate=elizabeth|Maryland=elizabeth
|Hayes & Harlington=elizabeth|Southall=elizabeth|West Drayton=elizabeth|Denmark Hill=windrush|Peckham Rye=windrush|Crystal Palace=windrush
|New Cross Gate=windrush|Surrey Quays=windrush|Rotherhithe=windrush|Wapping=windrush|Watford Junction=lioness|Wembley Central=bakerloo lioness
|Harrow & Wealdstone=bakerloo lioness|Queen's Park=bakerloo lioness|Kilburn High Road=lioness|Willesden Junction=bakerloo lioness mildmay
|Gospel Oak=mildmay suffragette|Barking=district hammersmith-city suffragette|Upminster=district liberty|Hackney Downs=weaver|London Fields=weaver
|Cambridge Heath=weaver|Enfield Town=weaver|Chingford=weaver|Camden Road=mildmay|Hampstead Heath=mildmay|Brondesbury=mildmay`;

let tflStations: Map<string, string[]> | null = null;

function tflTable(): Map<string, string[]> {
  if (!tflStations) {
    const map = new Map<string, string[]>();
    for (const part of TFL_STATIONS.split("|")) {
      const [name, lines] = part.split("=");
      if (name && lines) map.set(withoutLondon(stationKey(name)), lines.trim().split(/\s+/));
    }
    tflStations = map;
  }
  return tflStations;
}

/** The TfL lines at a station from a journey history ("Kings Cross St. Pancras", "Bank"). Empty when it isn't in the table. */
export function linesAt(name: string): string[] {
  const map = tflTable();
  const look = (s: string) => map.get(withoutLondon(stationKey(s.replace(/\b(?:underground|tube|dlr|overground|elizabeth line)\b/gi, " ")))) ?? null;
  // "Hammersmith (District & Piccadilly)", then "Bank / Monument" as its first station.
  return look(name) ?? look(name.replace(/\([^)]*\)/g, " ")) ?? look(name.split("/")[0]) ?? [];
}

/**
 * The lines someone travels most, from their journey history's titles
 * ("Highbury & Islington → Old Street", lib/tfl-csv.ts): a journey counts for
 * the lines both ends share, or (when they share none, so there was a change)
 * half for each line at either end. Buses don't count. At most `max` lines,
 * each used at least twice, busiest first.
 */
export function busiestLines(titles: string[], max = 3): string[] {
  const score = new Map<string, number>();
  const add = (ids: string[], by: number) => ids.forEach((id) => score.set(id, (score.get(id) ?? 0) + by));
  for (const title of titles) {
    if (/^Bus\b/i.test(title)) continue;
    const ends = title.split(" → ").map((p) => p.replace(/^(?:From|To) /, ""));
    const lines = ends.map(linesAt).filter((l) => l.length);
    if (!lines.length) continue;
    if (lines.length === 1) {
      add(lines[0], 1 / lines[0].length);
      continue;
    }
    const shared = lines[0].filter((l) => lines[1].includes(l));
    if (shared.length) add(shared, 1);
    else add([...new Set([...lines[0], ...lines[1]])], 0.5);
  }
  return [...score]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([id]) => id);
}

// Plex and Jellyfin replies, in the shapes their APIs return (no live server was available to record from on 7 Nov 2026):
// Plex from clients.plex.tv/api/v2/resources and /status/sessions/history/all as python-plexapi and Plex's own
// web app read them; Jellyfin from its OpenAPI (10.9): /System/Info, /Users, and /Items with EnableUserData.
// Times: 6 Nov 2026 in Europe/London (GMT).

export const PLEX_MACHINE = "4f1d2c3b5a6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c";
export const PLEX_PUBLIC_URI = "https://81-2-69-142.4f1d2c3b5a6e7d8c9b0a1f2e3d4c5b6a.plex.direct:32400";
export const PLEX_LOCAL_URI = "https://192-168-1-20.4f1d2c3b5a6e7d8c9b0a1f2e3d4c5b6a.plex.direct:32400";
export const PLEX_RELAY_URI = "https://139-162-1-1.4f1d2c3b5a6e7d8c9b0a1f2e3d4c5b6a.plex.direct:8443";

export const PLEX_RESOURCES = [
  { name: "Jordan's iPhone", product: "Plex for iOS", provides: "client,player", owned: true, clientIdentifier: "phone-1", connections: [] },
  {
    name: "Friend's server",
    product: "Plex Media Server",
    provides: "server",
    owned: false,
    clientIdentifier: "friend-1",
    accessToken: "friend-token",
    connections: [{ protocol: "https", address: "203.0.113.9", port: 32400, uri: "https://203-0-113-9.friend.plex.direct:32400", local: false, relay: false }],
  },
  {
    name: "Living room",
    product: "Plex Media Server",
    productVersion: "1.41.2.9200",
    provides: "server",
    owned: true,
    clientIdentifier: PLEX_MACHINE,
    accessToken: "server-access-token",
    publicAddress: "81.2.69.142",
    connections: [
      { protocol: "https", address: "192.168.1.20", port: 32400, uri: PLEX_LOCAL_URI, local: true, relay: false, IPv6: false },
      { protocol: "https", address: "81.2.69.142", port: 32400, uri: PLEX_PUBLIC_URI, local: false, relay: false, IPv6: false },
      { protocol: "https", address: "139.162.1.1", port: 8443, uri: PLEX_RELAY_URI, local: false, relay: true, IPv6: false },
    ],
  },
];

const ep = (historyKey: number, title: string, season: number, index: number, viewedAt: number, accountID = 1) => ({
  historyKey: `/status/sessions/history/${historyKey}`,
  key: `/library/metadata/${historyKey + 1000}`,
  ratingKey: String(historyKey + 1000),
  librarySectionID: "2",
  parentKey: "/library/metadata/500",
  grandparentKey: "/library/metadata/499",
  title,
  grandparentTitle: "Slow Horses",
  type: "episode",
  index,
  parentIndex: season,
  originallyAvailableAt: "2024-09-04",
  viewedAt,
  accountID,
  deviceID: 3,
});

/** The server owner's plays, newest first (what accountID=1&sort=viewedAt:desc returns), plus one by someone else. */
export const PLEX_HISTORY = [
  // 6 Nov 2026 22:10 GMT
  { historyKey: "/status/sessions/history/90", key: "/library/metadata/7001", ratingKey: "7001", librarySectionID: "1", title: "Paddington in Peru", type: "movie", originallyAvailableAt: "2024-11-08", viewedAt: 1794003000, accountID: 1, deviceID: 3 },
  ep(89, "Hello Goodbye", 4, 2, 1793996400), // 6 Nov 20:20
  ep(88, "Identity Theft", 4, 1, 1793993400), // 6 Nov 19:30
  ep(87, "Episode watched by a guest", 4, 3, 1793990000, 7),
  // 5 Nov 2026 21:00 GMT
  { historyKey: "/status/sessions/history/86", key: "/library/metadata/7002", ratingKey: "7002", title: "Conclave", type: "movie", year: 2024, viewedAt: 1793912400, accountID: 1, deviceID: 3 },
  // A song: not a film or episode.
  { historyKey: "/status/sessions/history/85", ratingKey: "9001", title: "Halcyon", type: "track", viewedAt: 1793910000, accountID: 1 },
];

/** Plex's history as the server answers it: accountID, viewedAt> / viewedAt< and the container window. */
export function plexHistoryReply(url: URL) {
  const after = Number(url.searchParams.get("viewedAt>") ?? 0);
  const before = Number(url.searchParams.get("viewedAt<") ?? Infinity);
  const account = url.searchParams.get("accountID");
  const kept = PLEX_HISTORY.filter((h) => h.viewedAt >= after && h.viewedAt <= before && (!account || String(h.accountID) === account));
  const start = Number(url.searchParams.get("X-Plex-Container-Start") ?? 0);
  const size = Number(url.searchParams.get("X-Plex-Container-Size") ?? 1000);
  const page = kept.slice(start, start + size);
  return { MediaContainer: { size: page.length, totalSize: kept.length, offset: start, Metadata: page } };
}

// ---------- Jellyfin ----------

export const JELLYFIN_BASE = "https://jellyfin.example.com";
export const JELLYFIN_SERVER_ID = "8d3c1e7b2a9f4c6d8e0f1a2b3c4d5e6f";
export const JELLYFIN_INFO = { ServerName: "Home", Version: "10.10.3", Id: JELLYFIN_SERVER_ID, OperatingSystem: "Linux", StartupWizardCompleted: true };
export const JELLYFIN_USERS = [
  { Name: "kids", Id: "u-kids", ServerId: JELLYFIN_SERVER_ID, Policy: { IsAdministrator: false, IsDisabled: false } },
  { Name: "jordan", Id: "u-jordan", ServerId: JELLYFIN_SERVER_ID, Policy: { IsAdministrator: true, IsDisabled: false } },
];

const jf = (Id: string, Name: string, Type: string, LastPlayedDate: string, extra: Record<string, unknown> = {}) => ({
  Name,
  ServerId: JELLYFIN_SERVER_ID,
  Id,
  Type,
  IsFolder: false,
  UserData: { PlaybackPositionTicks: 0, PlayCount: 1, IsFavorite: false, Played: true, Key: Id, LastPlayedDate, ItemId: Id },
  ...extra,
});

/** jordan's played films and episodes, last played first. */
export const JELLYFIN_PLAYED = [
  jf("e-3", "The Long Night", "Episode", "2026-11-06T21:45:00.0000000Z", { SeriesName: "Shōgun", SeriesId: "s-shogun", SeasonId: "se-1", ParentIndexNumber: 1, IndexNumber: 3, ProductionYear: 2024 }),
  jf("e-2", "Servants of Two Masters", "Episode", "2026-11-06T20:50:00.0000000Z", { SeriesName: "Shōgun", SeriesId: "s-shogun", SeasonId: "se-1", ParentIndexNumber: 1, IndexNumber: 2, ProductionYear: 2024 }),
  jf("m-1", "Past Lives", "Movie", "2026-11-06T18:00:00.0000000Z", { ProductionYear: 2023, UserData: { PlayCount: 2, Played: true, LastPlayedDate: "2026-11-06T18:00:00.0000000Z" } }),
  jf("m-2", "Heat", "Movie", "2026-11-04T21:00:00.0000000Z", { ProductionYear: 1995 }),
  jf("m-3", "Arrival", "Movie", "2026-10-30T20:00:00.0000000Z", { ProductionYear: 2016 }),
];

/** Jellyfin's /Items as the server answers it: StartIndex and Limit over the played list. */
export function jellyfinItemsReply(url: URL) {
  const start = Number(url.searchParams.get("StartIndex") ?? 0);
  const limit = Number(url.searchParams.get("Limit") ?? 1000);
  return { Items: JELLYFIN_PLAYED.slice(start, start + limit), TotalRecordCount: JELLYFIN_PLAYED.length, StartIndex: start };
}

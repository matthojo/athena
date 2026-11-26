/**
 * Life-log services reached through their own APIs (Reddit, Spotify, Last.fm, Steam).
 * Joined into CONNECTOR_PRESETS by lib/connector-presets.ts; see there for the fields.
 *
 * None has an official hosted MCP server that any client can use, so Athena
 * calls each API itself (netlify/lib/connectors/{reddit,spotify,lastfm,steam}-direct.ts),
 * GETs only. Reddit and Spotify sign in with the owner's own app and read
 * scopes; Last.fm and Steam take an API key, and the account's URL is the
 * owner's profile address, which only the service's own domain may be.
 */
import type { ConnectorPreset } from "../connector-presets";

export type ApiBProvider = "reddit" | "spotify" | "lastfm" | "steam";

export const REDDIT_API_URL = "https://oauth.reddit.com";
export const SPOTIFY_API_URL = "https://api.spotify.com/v1";

/** Read-only: who you are, your own history (posts, comments, saved, upvoted), and reading posts. No messages, no voting, no posting. */
export const REDDIT_SCOPE = "identity history read";
export const SPOTIFY_SCOPE = "user-read-recently-played user-library-read user-top-read playlist-read-private playlist-read-collaborative";

/** Hosts a profile address may be on. */
export const LASTFM_HOSTS = ["www.last.fm", "last.fm", "m.last.fm"];
export const STEAM_HOSTS = ["steamcommunity.com", "www.steamcommunity.com"];

/** Does Athena call this service's API itself for this account? Reddit and Spotify with a sign-in; Last.fm and Steam with a key. */
export function apiBDirect(c: { provider: string; auth_type: string }): boolean {
  if (c.provider === "reddit" || c.provider === "spotify") return c.auth_type === "oauth";
  if (c.provider === "lastfm" || c.provider === "steam") return c.auth_type === "token";
  return false;
}

export const API_B_PRESETS: ConnectorPreset[] = [
  {
    id: "reddit",
    label: "Reddit",
    tagline: "Your posts, comments and saves",
    icon: "chat",
    category: "social",
    url: REDDIT_API_URL,
    auth: "oauth",
    scope: REDDIT_SCOPE,
    needsOwnClient: true,
    ownClientLabel: "Reddit",
    clientIdHint: "Under your app's name",
    readTools: ["my_posts", "my_comments", "my_saved", "my_upvoted"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: "Make a Reddit app once, free. At reddit.com/prefs/apps choose Create app, pick web app, name it Athena and paste the redirect URI above. Copy the code under the app's name into Client ID, and the secret into Secret. Reddit now checks new apps by hand, so it may take a few weeks before sign-in works. Athena reads only your own posts, comments, saves and upvotes. It never opens your messages.",
  },
  {
    id: "spotify",
    label: "Spotify",
    tagline: "What you play, save and put in playlists",
    icon: "music",
    category: "entertainment",
    url: SPOTIFY_API_URL,
    auth: "oauth",
    scope: SPOTIFY_SCOPE,
    needsOwnClient: true,
    ownClientLabel: "Spotify",
    clientIdHint: "Client ID",
    readTools: ["recently_played", "saved_tracks", "saved_albums", "top_items", "list_playlists", "list_playlist_tracks"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: "Make a Spotify app once, free. Your account needs Premium. At developer.spotify.com/dashboard choose Create app, name it Athena, paste the redirect URI above and tick Web API. Copy the Client ID, and the Client secret from Settings. Spotify keeps only your last 50 plays, so set your Life log to run every few hours.",
  },
  {
    id: "lastfm",
    label: "Last.fm",
    tagline: "Every song you've scrobbled",
    icon: "music",
    category: "entertainment",
    url: "",
    urlHint: "https://www.last.fm/user/yourname",
    auth: "token",
    scope: "",
    readTools: ["list_scrobbles", "top_artists"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: "Put your profile address in URL. For Token, open last.fm/api/account/create, name the app Athena and copy the API key. If Hide recent listening is on in Last.fm's privacy settings, Athena can't see what you play.",
  },
  {
    id: "steam",
    label: "Steam",
    tagline: "What you played, and for how long",
    icon: "game",
    category: "entertainment",
    url: "",
    urlHint: "https://steamcommunity.com/id/yourname",
    auth: "token",
    scope: "",
    readTools: ["recently_played", "played_games"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: "Put your profile address in URL. For Token, get a key at steamcommunity.com/dev/apikey (any domain name works). Steam shows nothing for a private profile, even to your own key, so set Game details to Public in your Steam privacy settings.",
  },
];

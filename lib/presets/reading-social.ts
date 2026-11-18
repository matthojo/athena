/**
 * Readwise highlights and your own Bluesky and Mastodon posts, for the Life log.
 * Joined into CONNECTOR_PRESETS by lib/connector-presets.ts; see there for the fields.
 *
 * None has an MCP server Athena can use, so Athena calls each API itself
 * (netlify/lib/connectors/{readwise,bluesky,mastodon}-direct.ts), GETs only.
 *  - Readwise: the owner's access token (readwise.io/access_token).
 *  - Bluesky: no sign-in. Your profile link or handle; posts come from
 *    Bluesky's public AppView, the same posts anyone can see.
 *  - Mastodon: your profile link (which names your server) and an access
 *    token with read access only, made in Preferences → Development.
 */
import type { ConnectorPreset } from "../connector-presets";

export type ReadingSocialProvider = "readwise" | "readwise-reader" | "bluesky" | "mastodon";

export const READWISE_API_URL = "https://readwise.io/api/v2";
/** Bluesky's public AppView: reads anyone's public posts, no sign-in. */
export const BLUESKY_APPVIEW_URL = "https://public.api.bsky.app";
/** Profile links a Bluesky account may be given as. */
export const BLUESKY_HOSTS = ["bsky.app", "www.bsky.app"];
/** Readwise's own hosted MCP server: Reader documents and highlights, signed in with OAuth (Athena registers itself). */
export const READWISE_MCP_URL = "https://mcp2.readwise.io/mcp";
/** Of Readwise's openid, read and write: read only, so its tools that tag, move or delete are refused by Readwise too. */
export const READWISE_MCP_SCOPE = "read";
/** The only Mastodon permission Athena asks for. */
export const MASTODON_SCOPE = "read";

/** Does Athena call this service's API itself? Readwise and Mastodon with a key; Bluesky with nothing. Mirrors each adapter's `handles`. */
export function readingSocialDirect(c: { provider: string; auth_type: string }): boolean {
  if (c.provider === "readwise" || c.provider === "mastodon") return c.auth_type === "token";
  if (c.provider === "bluesky") return c.auth_type === "none";
  return false;
}

export const READING_SOCIAL_PRESETS: ConnectorPreset[] = [
  {
    id: "readwise",
    label: "Readwise",
    tagline: "What you highlight as you read",
    icon: "bookmark",
    category: "entertainment",
    url: READWISE_API_URL,
    auth: "token",
    scope: "",
    readTools: ["list_highlights", "search_highlights"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: "Copy your access token at readwise.io/access_token and paste it here. Athena reads your highlights and notes from Kindle, Apple Books, Reader and the rest. Your days say which books you highlighted, never the highlights themselves.",
  },
  {
    id: "readwise-reader",
    label: "Readwise Reader",
    tagline: "Search what you saved to read",
    icon: "library",
    category: "entertainment",
    url: READWISE_MCP_URL,
    auth: "oauth",
    scope: READWISE_MCP_SCOPE,
    // Readwise's docs name its tools only in words: what its server marks read-only is allowed, and anything that tags, moves, edits or deletes is refused.
    readTools: [],
    // Ask only: the Life log reads highlights through Readwise (above).
    recipes: ["custom"],
    help: "Athena asks Readwise for read access only, so Ask can search the articles and documents you saved in Reader. It can't tag, move or delete anything.",
  },
  {
    id: "bluesky",
    label: "Bluesky",
    tagline: "Your posts and replies",
    icon: "chat",
    category: "social",
    url: "",
    urlHint: "https://bsky.app/profile/you.bsky.social",
    auth: "none",
    scope: "",
    readTools: ["my_posts"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: "Paste your profile link or handle. Athena needs no sign-in: it reads the posts and replies anyone can see on your profile, not reposts.",
  },
  {
    id: "mastodon",
    label: "Mastodon",
    tagline: "Your posts, on any server",
    icon: "chat",
    category: "social",
    url: "",
    urlHint: "https://mastodon.social/@you",
    auth: "token",
    scope: MASTODON_SCOPE,
    readTools: ["my_posts"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: "Your profile link tells Athena which server you're on. It reads your own posts and replies, not boosts or private mentions.",
  },
];

/**
 * Community: what passes between Athena's server and its app. Types only, so both sides can import them; the
 * app's calls are app/src/db/community.ts, the screens `#/community` and `#/add`.
 *
 * Every way in (a catalogue listing, a link, files) ends at one preview, and nothing is kept until the owner says
 * Add. The server never trusts a preview the app sends back: on Add it reads and checks the files again, works out
 * their hash and reach again, and for a catalogue item checks the hash against the index. What's added starts
 * switched off, and nothing in a file is a permission: ticks, answers and switches come from the owner's choices.
 *
 * Routes (netlify/lib/community-routes.ts, then netlify/lib/community-add-routes.ts for preview and add):
 *
 * GET  /api/community                                → CatalogueView
 * POST /api/community/preview   AddRequest           → { preview: AddPreview }   (files: multipart, field `files`)
 * POST /api/community/add       { preview, choices } → AddResult
 * GET  /api/community/updates                        → { updates: UpdateCheck[] }
 * PUT  /api/community/settings  { on: boolean }      → { on: boolean }           (lib/community-config.ts)
 */
import type { CatalogueFile, CatalogueItem } from "./catalogue-types";
import type { SharedFlow } from "./flow-share";
import type { Reach } from "./reach";
import type { ShareHeader, ShareKind } from "./share-kinds";
import type { SkillPreview } from "./skills";
import type { SharedAssistant, SharedSkill } from "./team-share";

/** The Community screen's data. */
export interface CatalogueView {
  /** ATHENA_CATALOGUE_URL is set. */
  configured: boolean;
  /** The owner's "Check the Community catalogue" switch. */
  on: boolean;
  /** Where the list comes from, for the line that says so: the catalogue's host and path, "catalogue.example.com/v1". */
  host?: string | null;
  /** When the index was made, as it says. Null when none was read. */
  generated_at: string | null;
  /** Items this Athena can read (formatReadable), newest first. Empty while off or not configured. */
  items: CatalogueItem[];
  /** Ids of listings already added here, so the list can say so. */
  added: string[];
  /** In words, when the catalogue couldn't be read. */
  error: string | null;
}

/** A preview request as the server takes it as JSON. Files go as multipart instead. */
export type AddRequest = { catalogue: string } | { link: string };

/** What the file is, read and checked, by kind. */
export type AddPreviewItem =
  | { kind: "assistant"; shared: SharedAssistant; skill: SharedSkill | null }
  | { kind: "skill"; skill: SkillPreview }
  | { kind: "flow"; flow: SharedFlow };

/** Everything the `#/add` screen shows before anything is kept. */
export interface AddPreview {
  kind: ShareKind;
  item: AddPreviewItem;
  name: string;
  summary: string;
  header: ShareHeader;
  /** Worked out here from the files, never the catalogue's or author's word. */
  reach: Reach;
  /** The files as read: shown on request, and sent back with Add. */
  files: CatalogueFile[];
  /** bundleHash(files). */
  hash: string;
  /** Where it came from. */
  from: { catalogue: string } | { link: string } | { files: string };
  /** For a catalogue item: its listing. */
  listing: Pick<CatalogueItem, "id" | "version" | "featured" | "added_at"> | null;
  /**
   * An item of this kind here that came from the same listing, if any: "You already have this", with a way to open
   * it, and Update when the listing's files differ from what was added (`newer`). A second copy is a deliberate tap.
   */
  existing: { id: string; version: string | null; href: string; newer: boolean } | null;
  /** Files listed but not used (scripts, binaries, over the size limit), with why. */
  skipped: Array<{ path: string; reason: string }>;
}

/** What the owner chose on the preview. Nothing is on unless it's here. */
export interface AddChoices {
  /** Answers to its questions, by question (assistant, skill) or by ask key (flow). */
  answers: Record<string, string>;
  /** Connected accounts ticked for it (connectors.id). */
  accounts: string[];
  /** Tools an assistant may run without asking, ticked from what it asked for (lib/shared-limits.ts). */
  allow: string[];
  /** Web search, when it asked. */
  web: boolean;
  /** Reading spending, when a flow asked. */
  money: boolean;
  /** For a flow with thinking steps: the assistant that runs it, or null for none (those steps are then refused). */
  assistant_id: string | null;
  /**
   * Update this one (the preview's `existing.id`) to the listing's version instead of adding a copy. Only for a
   * catalogue item, and only the one the server finds came from that listing.
   */
  replace?: string | null;
}

export interface AddResult {
  kind: ShareKind;
  /** The new (or updated) assistant, skill or flow. */
  id: string;
  /** Where to open it in the app: "#/team/<id>", "#/settings/skills/<id>", "#/flows/<id>". */
  href: string;
  /** It was an update of one already here, not a new one. */
  updated?: boolean;
}

/** An item added from the catalogue, against the index now. */
export interface UpdateCheck {
  kind: ShareKind;
  /** The assistant, skill or flow here. */
  id: string;
  catalogue_id: string;
  /** As added: its catalogue_version and catalogue_hash. */
  version: string | null;
  hash: string;
  /** The listing now, when its hash differs from what was added. Its reach is the catalogue's word for the new files. */
  newer: Pick<CatalogueItem, "version" | "hash" | "summary" | "reach"> | null;
  /** The tier of what's here now, worked out from it, when there's a newer listing: so a change of tier can lead. */
  tier_here?: Reach["tier"] | null;
  /** Taken down, with the catalogue's reason. It stays here either way. */
  withdrawn: { at: string; reason: string } | null;
}

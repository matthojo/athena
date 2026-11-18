/**
 * The whole graph in one read, for the app's Graph page (GET /api/graph).
 *
 * Nodes are every live note, person, place, organisation, event and custom
 * record (one of the owner's own kinds, while that kind isn't archived), plus the
 * layer-2 things that hang off them: catch-ups (interactions), to-dos
 * (commitments, not dropped), current facts and reading recommendations, and
 * saved items, to-dos and Watch & read titles that something links to (a
 * note's @-mention, migration 0044). A layer-2 item is only a node when
 * something links it, so the graph never fills with loose to-dos.
 *
 * Links come from `edges` (both origins) and from layer 2's own columns:
 * interaction_people, commitments.person_id, a fact's subject,
 * reading_items.recommended_by and events.person_id (birthdays). Anything
 * archived is left out on both ends, because links only join live nodes.
 * Each pair of nodes keeps one link, whatever the direction or relation.
 *
 * Kept apart from lib/db.ts so the graph's SQL lives in one place. Titles and
 * subtitles are encrypted at rest (SECURITY.md §11), so the SQL only ever
 * selects them whole (q() decrypts whole values) and any shaping, such as a
 * fact's "key: value", an address's first line or a tidy website, happens
 * here after decryption.
 */
import { q } from "./db";

export type GraphKind = "note" | "person" | "place" | "organisation" | "event" | "record" | "saved" | "interaction" | "commitment" | "fact" | "reading";

export interface GraphNode {
  id: string;
  kind: GraphKind;
  title: string;
  /** One short line of context: a note's type, a person's relationship, an event's kind, a catch-up's channel… */
  sub: string;
  /** When a catch-up happened (UTC instant); null for everything else. */
  at: string | null;
  /** A custom record's kind (custom_kinds.id), so the Graph can filter by it; absent otherwise. */
  kind_id?: string;
  /** How many other nodes it links to. */
  degree: number;
}

export interface GraphLink {
  source: string;
  target: string;
  /** An edge's relation (mentions, works_at, relates_to…) or catch_up, to_do, fact, recommended, birthday, about. */
  relation: string;
}

export interface Graph {
  nodes: GraphNode[];
  links: GraphLink[];
}

const GRAPH_SQL = `
  WITH live_people AS (SELECT id FROM people WHERE archived_at IS NULL),
  -- Saved items, to-dos and Watch & read titles a note (or anything) links to: they join the graph through those links.
  edged AS (
    SELECT source_type AS kind, source_id AS id FROM edges WHERE source_type IN ('saved', 'commitment', 'reading')
    UNION SELECT target_type, target_id FROM edges WHERE target_type IN ('saved', 'commitment', 'reading')
  ),
  nodes AS (
    SELECT 'note' AS kind, id, title, type AS sub, NULL::text AS at, NULL::text AS prefix, NULL::text AS kind_id FROM notes WHERE archived_at IS NULL
    UNION ALL SELECT 'person', id, name, relationship, NULL, NULL, NULL FROM people WHERE archived_at IS NULL
    UNION ALL SELECT 'place', id, name, address, NULL, NULL, NULL FROM places WHERE archived_at IS NULL
    UNION ALL SELECT 'organisation', id, name, website, NULL, NULL, NULL FROM organisations WHERE archived_at IS NULL
    UNION ALL SELECT 'event', id, title, kind, NULL, NULL, NULL FROM events
      WHERE archived_at IS NULL AND (person_id IS NULL OR person_id IN (SELECT id FROM live_people))
    UNION ALL SELECT 'record', r.id, r.title, k.one, NULL, NULL, r.kind_id::text
      FROM custom_records r JOIN custom_kinds k ON k.id = r.kind_id AND k.archived_at IS NULL
     WHERE r.archived_at IS NULL
    UNION ALL SELECT 'saved', s.id, COALESCE(s.title, s.quote, s.note, s.site), COALESCE(s.thing, s.kind), NULL, NULL, NULL
      FROM saved_items s
     WHERE s.archived_at IS NULL AND s.id IN (SELECT id FROM edged WHERE kind = 'saved')
    UNION ALL SELECT 'interaction', i.id, i.summary, i.channel, to_char(i.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), NULL, NULL
      FROM interactions i
     WHERE i.archived_at IS NULL
       AND EXISTS (SELECT 1 FROM interaction_people ip JOIN live_people p ON p.id = ip.person_id WHERE ip.interaction_id = i.id)
    UNION ALL SELECT 'commitment', c.id, c.title, CASE WHEN c.status = 'done' AND c.kind <> 'decision' THEN 'done' ELSE c.kind END, NULL, NULL, NULL
      FROM commitments c
     WHERE c.archived_at IS NULL AND c.status <> 'dropped'
       AND (c.person_id IN (SELECT id FROM live_people) OR c.id IN (SELECT id FROM edged WHERE kind = 'commitment'))
    UNION ALL SELECT 'fact', f.id, f.value, f.subject_kind, NULL, f.key, NULL
      FROM facts f
     WHERE f.archived_at IS NULL AND f.superseded_at IS NULL
       AND CASE f.subject_kind
             WHEN 'person' THEN f.subject_id IN (SELECT id FROM live_people)
             WHEN 'place' THEN f.subject_id IN (SELECT id FROM places WHERE archived_at IS NULL)
             WHEN 'organisation' THEN f.subject_id IN (SELECT id FROM organisations WHERE archived_at IS NULL)
             ELSE FALSE
           END
    UNION ALL SELECT 'reading', r.id, r.title, r.kind, NULL, NULL, NULL
      FROM reading_items r
     WHERE r.archived_at IS NULL
       AND (r.recommended_by IN (SELECT id FROM live_people) OR r.id IN (SELECT id FROM edged WHERE kind = 'reading'))
  ),
  raw_links AS (
    SELECT source_type AS a_kind, source_id AS a, target_type AS b_kind, target_id AS b, relation FROM edges
    UNION ALL SELECT 'interaction', interaction_id, 'person', person_id, 'catch_up' FROM interaction_people
    UNION ALL SELECT 'commitment', id, 'person', person_id, 'to_do' FROM commitments WHERE person_id IS NOT NULL
    UNION ALL SELECT 'fact', id, subject_kind, subject_id, 'fact' FROM facts WHERE subject_id IS NOT NULL
    UNION ALL SELECT 'reading', id, 'person', recommended_by, 'recommended' FROM reading_items WHERE recommended_by IS NOT NULL
    UNION ALL SELECT 'event', id, 'person', person_id, CASE WHEN kind = 'birthday' THEN 'birthday' ELSE 'about' END
      FROM events WHERE person_id IS NOT NULL
  ),
  -- Only links with a live node on both ends; one per pair of nodes.
  links AS (
    SELECT DISTINCT ON (LEAST(r.a, r.b), GREATEST(r.a, r.b)) r.a AS source, r.b AS target, r.relation
      FROM raw_links r
      JOIN nodes x ON x.kind = r.a_kind AND x.id = r.a
      JOIN nodes y ON y.kind = r.b_kind AND y.id = r.b
     WHERE r.a <> r.b
     ORDER BY LEAST(r.a, r.b), GREATEST(r.a, r.b), r.relation
  )
  SELECT
    (SELECT COALESCE(json_agg(json_build_object('id', id, 'kind', kind, 'title', title, 'sub', sub, 'at', at, 'prefix', prefix, 'kind_id', kind_id)
                              ORDER BY kind, id), '[]'::json) FROM nodes) AS nodes,
    (SELECT COALESCE(json_agg(json_build_object('source', source, 'target', target, 'relation', relation)
                              ORDER BY source, target), '[]'::json) FROM links) AS links`;

/** Every live node and the links between them, with each node's degree. One round trip. */
/** A node's subtitle, shaped after decryption: an address's first line, a website without its scheme. */
function shapeSub(kind: GraphKind, sub: string | null): string {
  const text = sub ?? "";
  if (kind === "saved") return text;
  if (kind === "place") return text.split("\n")[0].trim();
  if (kind === "organisation") return text.replace(/^https?:\/\/(www\.)?|\/$/g, "");
  return text;
}

/** A saved item's title, or its quote's or note's first line, cut short. */
function savedLine(title: string | null): string {
  const line = (title ?? "").split("\n")[0].trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export async function loadGraph(): Promise<Graph> {
  const [raw] = await q<{
    nodes: Array<Omit<GraphNode, "degree" | "title" | "sub" | "kind_id"> & { title: string | null; sub: string | null; prefix: string | null; kind_id: string | null }>;
    links: GraphLink[];
  }>(GRAPH_SQL);
  const row = {
    links: raw.links,
    nodes: raw.nodes.map(({ prefix, title, sub, kind_id, ...n }) => ({
      ...n,
      title: prefix ? `${prefix}: ${title ?? ""}` : n.kind === "saved" ? savedLine(title) : (title ?? ""),
      sub: shapeSub(n.kind, sub),
      ...(kind_id ? { kind_id } : {}),
    })),
  };
  const degree = new Map<string, number>();
  for (const l of row.links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  return {
    nodes: row.nodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 })),
    links: row.links,
  };
}

/**
 * What a Your activity run's line counts, in order: "6 plays, 1 watch,
 * 2 books, 1 workout" (netlify/lib/connectors/media-sync.ts writes it, the
 * app reads it back from the run's stats). Shared so both say it the same way.
 */
export const WORDS = [
  ["play", "plays"],
  ["watch", "watches"],
  ["like", "likes"],
  ["book", "books"],
  ["highlight", "highlights"],
  ["game", "games"],
  ["chess game", "chess games"],
  ["post", "posts"],
  ["save", "saves"],
  ["bookmark", "bookmarks"],
  ["event", "events"],
  ["habit", "habits"],
  ["workout", "workouts"],
  ["health day", "health days"],
] as const;

export type Word = (typeof WORDS)[number][0];

/** A word's key in a run's stats: "play" → plays_new, "chess game" → chess_games_new. */
export const statKey = (w: Word): string => `${WORDS.find(([one]) => one === w)![1].replace(/ /g, "_")}_new`;

/** The line from a run's stats: "6 plays, 1 watch, 2 books", or "Nothing new". */
export function activityLineFromStats(stats: Record<string, unknown>): string {
  const parts = WORDS.flatMap(([one, many]) => {
    const n = stats[statKey(one)];
    return typeof n === "number" && n > 0 ? [`${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`] : [];
  });
  return parts.length ? parts.join(", ") : "Nothing new";
}

/** Everything a run's stats say is new. */
export function activityTotal(stats: Record<string, unknown>): number {
  return WORDS.reduce((sum, [one]) => {
    const n = stats[statKey(one)];
    return sum + (typeof n === "number" ? n : 0);
  }, 0);
}

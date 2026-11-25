/**
 * Turns a raw `notes.source` value into something a person reads. Sources are
 * "<domain>" or "<domain>-<label>" (the register-collection-agent skill's
 * convention, e.g. "email-digest-personal"), so the domain picks the name and
 * icon and any trailing label becomes a small tag.
 */

import type { IconName } from "../components/icons";
import type { Note } from "../types";

const DOMAINS: { key: string; name: string; icon: IconName }[] = [
  { key: "calendar-meetings", name: "Meetings", icon: "calendar" },
  // Events kept in step by Athena itself (netlify/lib/connectors/calendar-sync.ts).
  { key: "calendar-sync", name: "Calendar", icon: "week" },
  { key: "work-activity", name: "Work activity", icon: "briefcase" },
  { key: "email-digest", name: "Email digest", icon: "mail" },
  { key: "life-log", name: "Life log", icon: "play" },
  { key: "finance", name: "Finance", icon: "wallet" },
  { key: "manual", name: "From you", icon: "pen" },
  // Written by Athena itself each morning (netlify/functions/reminders.ts).
  { key: "briefing", name: "Briefings", icon: "sparkle" },
];

export interface SourceInfo {
  key: string;
  name: string;
  label: string | null;
  icon: IconName;
}

function words(s: string): string {
  const text = s.replace(/[-_]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function describeSource(source: string | null): SourceInfo {
  if (!source) return { key: "", name: "Other", label: null, icon: "folder" };
  for (const d of DOMAINS) {
    if (source === d.key) return { key: source, name: d.name, label: null, icon: d.icon };
    if (source.startsWith(`${d.key}-`)) {
      return { key: source, name: d.name, label: words(source.slice(d.key.length + 1)), icon: d.icon };
    }
  }
  return { key: source, name: words(source), label: null, icon: "folder" };
}

export function sourceText(source: string | null): string {
  const s = describeSource(source);
  return s.label ? `${s.name} · ${s.label}` : s.name;
}

export interface SourceSummary {
  info: SourceInfo;
  count: number;
}

export function summarizeSources(notes: Note[]): SourceSummary[] {
  const counts = new Map<string, number>();
  for (const n of notes) {
    const key = n.source ?? "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ info: describeSource(key || null), count }))
    .sort((a, b) => b.count - a.count || sourceText(a.info.key || null).localeCompare(sourceText(b.info.key || null)));
}

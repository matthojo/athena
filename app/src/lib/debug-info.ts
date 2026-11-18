/**
 * The details Settings → About shows for a bug report, as text to copy into
 * an issue. Pure: components/about-settings.ts gathers the values. Nothing
 * here may carry content, keys, tokens or the site's address, since people
 * paste this somewhere public.
 */

export interface Detail {
  label: string;
  value: string;
}

/** "Athena details" then one "Label: value" line each, for pasting into an issue. */
export function formatDetails(details: Detail[]): string {
  return ["Athena details", ...details.map((d) => `${d.label}: ${d.value}`)].join("\n");
}

/** 1536 → "1.5 KB", in powers of 1024, one decimal under 10. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  if (i === 0) return `${n} ${n === 1 ? "byte" : "bytes"}`;
  return `${n < 10 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n)} ${units[i]}`;
}

/** "2026-11-18T09:05:00Z" → "18 Nov 2026, 09:05 UTC"; "never" when there's no time. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

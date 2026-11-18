/**
 * Where a Day opens in the app: the one place that knows its route, so
 * Ask's citations, search results and anything else that links a day agree
 * (the Day view itself is days-design's).
 */
export const dayHref = (date: string) => `#/days/${date}`;

export function openDay(date: string): void {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) location.hash = dayHref(date);
}

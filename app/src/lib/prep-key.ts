/** Home's "Prepare notes" cards as they'd be compared: the same meetings, times, titles and people mean nothing to repaint. */
export const prepKey = (list: Array<{ event_id: string; title: string; starts_at: string | Date; people: Array<{ id: string }> }>): string =>
  list.map((s) => `${s.event_id}|${new Date(s.starts_at).getTime()}|${s.title}|${s.people.map((p) => p.id).join(",")}`).join("\n");

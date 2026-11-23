/**
 * Clock times as the app writes them, one way everywhere: the device's own
 * 12- or 24-hour setting decides, and the words are the house style.
 * "22:43" on a 24-hour device, "10:43 pm" on a 12-hour one (lowercase, one
 * plain space, no leading zero). Dates, durations and "2 hours ago" are
 * someone else's job; values for time fields and the API stay "HH:MM".
 */

let forced: boolean | null = null;
let device: boolean | null = null;

/** Whether this device writes times on a 12-hour clock, as its time fields do. */
export function uses12Hour(): boolean {
  if (forced !== null) return forced;
  if (device === null) {
    try {
      // No hour12 or hourCycle asked for: this reads the device's own choice.
      device = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).resolvedOptions().hour12 === true;
    } catch {
      device = false;
    }
  }
  return device;
}

/** For tests and previews: pin the clock to 12-hour (true) or 24-hour (false); null goes back to the device's. */
export function setUses12Hour(hour12: boolean | null): void {
  forced = hour12;
}

export interface ClockOptions {
  /** Pin 12-hour (true) or 24-hour (false); left out, the device decides. */
  hour12?: boolean;
  /** An IANA zone to read the instant in; left out, the device's. */
  timeZone?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

function write(h: number, m: number, hour12: boolean): string {
  if (!hour12) return `${pad(h)}:${pad(m)}`;
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "am" : "pm"}`;
}

const zoned = new Map<string, Intl.DateTimeFormat>();
function hourMinuteIn(at: Date, timeZone: string): [number, number] | null {
  try {
    let f = zoned.get(timeZone);
    if (!f) zoned.set(timeZone, (f = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })));
    const parts = f.formatToParts(at);
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const h = n("hour");
    const m = n("minute");
    return Number.isFinite(h) && Number.isFinite(m) ? [h % 24, m] : null;
  } catch {
    return null;
  }
}

/** An instant's clock time: "22:43", or "10:43 pm" on a 12-hour device. "" when it isn't a time. */
export function clockTime(at: Date | string | number, options: ClockOptions = {}): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const hm = options.timeZone ? hourMinuteIn(d, options.timeZone) : null;
  return write(hm ? hm[0] : d.getHours(), hm ? hm[1] : d.getMinutes(), options.hour12 ?? uses12Hour());
}

/**
 * A stored time of day ("16:00", "9:05", "16:00:00") the same way: "16:00",
 * or "4:00 pm". Anything that isn't a time of day comes back as it was.
 */
export function clockOfDay(time: string | null | undefined, hour12: boolean = uses12Hour()): string {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec((time ?? "").trim());
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) return time ?? "";
  return write(Number(m[1]) % 24, Number(m[2]), hour12);
}

/** A span of the day: "09:00–10:30", or "9:00 am–10:30 am". */
export function clockSpan(from: string | null | undefined, to: string | null | undefined, hour12: boolean = uses12Hour()): string {
  return `${clockOfDay(from, hour12)}–${clockOfDay(to, hour12)}`;
}

/**
 * A sentence the shared words wrote with 24-hour times in it ("Lands 14:10",
 * "Tue 3 Nov 07:10"), with each one the way this device writes it. Only
 * whole "HH:MM" times are touched; on a 24-hour device nothing changes.
 */
export function clockInText(text: string, hour12: boolean = uses12Hour()): string {
  if (!hour12) return text;
  return text.replace(/(?<![\d:.])([01]\d|2[0-3]):([0-5]\d)(?![\d:])/g, (_, h: string, m: string) => write(Number(h), Number(m), true));
}

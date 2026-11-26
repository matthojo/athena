/**
 * Ask's assistant logging from a sentence: "I spent £4 on coffee", "slept 7
 * hours", "watched Perfect Days last night", "electricity meter reads 12345".
 * Kept beside lib/assistant.ts, which lists these with its own tools and runs
 * them through runLogTool().
 *
 * Nothing is saved from a model turn alone:
 * each tool prepares a card (lib/assistant-confirm.ts), and the app saves it
 * when the owner taps, through the manual-entry routes (POST
 * /api/life/spending, PUT /api/health/manual, POST /api/days/:date/entries,
 * POST /api/life/readings). log_spending is offered only while "Let Ask read
 * transactions" is on (lib/money.ts loadAskMoney), and refused here as well.
 * Health is laid over what was typed in for the day, never in place of it.
 */
import type { Anthropic } from "./ai";
import { WAITING, type ConfirmCard } from "./assistant-confirm";
import { entryCard, healthCard, logWords, readingCard, spendingCard, LOG_ENTRY_KINDS, type LogCard } from "./ask-logging";
import { MONEY_CATEGORIES } from "./day-types";
import { zonedToday } from "./dates";
import { MANUAL_HEALTH, readSourceDay } from "./health";
import { loadReadings } from "./meter-readings";

const DATE = { type: "string", description: "YYYY-MM-DD, the owner's local day. Leave out for today." } as const;

export const LOG_TOOLS: Anthropic.Tool[] = [
  {
    name: "log_spending",
    description:
      "Offer to add a payment the owner made to Money, for “I spent £4 on coffee”, “paid £32 for a taxi yesterday”, “£12.50 at the corner shop”. The app shows it for them to confirm and saves it only when they tap Add. " +
      "Give amount as they said it (“£4”, “12.50”). Pick the category that fits: eating_out (cafés, restaurants, coffee), takeaway, groceries, transport, shopping, bills, entertainment (going out), holidays, personal_care, general. After calling it, say in one short sentence that it's ready to add; never say it's saved.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        amount: { type: "string", description: "What was spent, as said: “£4”, “4.50”, “€12”." },
        currency: { type: "string", description: "Three letters, only when it isn't pounds and no symbol says so." },
        category: { type: "string", enum: [...MONEY_CATEGORIES] },
        what: { type: "string", description: "What it was, or where: “Coffee”, “Corner shop”. Short, in the owner's words." },
        date: DATE,
      },
      required: ["amount"],
    },
  },
  {
    name: "log_health",
    description:
      "Offer to log health figures the owner tells you, for “slept 7 hours”, “walked 9,000 steps”, “ran 5k in 28 minutes”, “weighed 72.4 kg this morning”, “had 3 coffees”, “two glasses of wine”. The app shows them for the owner to confirm and saves only when they tap Save. " +
      "Give only the figures they said: what they typed in for that day before stays as it is. Sleep goes on the day it ended: “slept 7 hours” or “last night I slept 6” is today. After calling it, say in one short sentence that it's ready to save; never say it's saved.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        date: DATE,
        sleep_hours: { type: "number", description: "Hours asleep: 7, 7.5." },
        steps: { type: "integer" },
        weight_kg: { type: "number", description: "In kilograms (a stone is 6.35 kg, a pound 0.4536 kg)." },
        resting_hr: { type: "integer", description: "Resting heart rate, beats per minute." },
        workout: {
          type: "object",
          additionalProperties: false,
          properties: { type: { type: "string", description: "run, walk, ride, swim, strength, yoga, hiit or other" }, minutes: { type: "integer" }, km: { type: "number", description: "Distance in km (a mile is 1.609 km)." } },
          required: ["type", "minutes"],
        },
        water_litres: { type: "number" },
        coffees: { type: "integer", description: "Cups of coffee." },
        alcohol_drinks: { type: "number", description: "Alcoholic drinks." },
        kcal: { type: "integer", description: "Calories eaten." },
        mindful_minutes: { type: "integer" },
      },
    },
  },
  {
    name: "log_day_entry",
    description:
      "Offer to add something the owner watched, listened to, read or played to that day in Days, for “watched Perfect Days last night”, “listened to the new Fontaines album”, “read two chapters of Piranesi”, “played Mario Kart with Sam”. The app shows it for them to confirm and adds it only when they tap Add. " +
      "Something watched “last night” goes on yesterday. A workout goes in log_health instead. This keeps it on the day only: for a watch & read list, use add_to_watch_read or update_watch_read. After calling it, say in one short sentence that it's ready to add; never say it's added.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: [...LOG_ENTRY_KINDS] },
        title: { type: "string", description: "The film's, show's, album's, book's or game's name, as said." },
        subtitle: { type: "string", description: "Who made it, or which episode (“S2E3”), when said." },
        minutes: { type: "integer", description: "How long, when said." },
        date: DATE,
      },
      required: ["kind", "title"],
    },
  },
  {
    name: "log_meter_reading",
    description:
      "Offer to add a meter reading for House, for “electricity meter reads 12345”, “gas is 4567.8”. The app shows it for the owner to confirm and adds it only when they tap Add; the use between readings becomes the home's days. " +
      "Electricity is in kWh. Gas is kWh, m3 (a newer meter, with a decimal point) or ft3 (an older one, in hundreds of cubic feet): give the unit only when the owner says it. After calling it, say in one short sentence that it's ready to add; never say it's added.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fuel: { type: "string", enum: ["electricity", "gas"] },
        value: { type: "number", description: "The number on the meter." },
        unit: { type: "string", enum: ["kwh", "m3", "ft3"] },
        date: DATE,
      },
      required: ["fuel", "value"],
    },
  },
];

export const LOG_TOOL_NAMES = new Set(LOG_TOOLS.map((t) => t.name));

/** The one gated on "Let Ask read transactions" (lib/ask-tools.ts MONEY_TOOL_NAMES does the same for the reads). */
export const LOG_MONEY_TOOL = "log_spending";

/** Said when log_spending is called while the switch is off. */
export const SPENDING_OFF = "Spending from Ask is off. Say so: the owner can turn on Let Ask read transactions in Settings, or add it on the Money page.";

export const LOG_GUIDANCE = `- Logging: when the owner tells you about money they spent, their sleep, steps, a workout, weight, coffee or drinks, something they watched, heard, read or played, or a meter reading, call log_spending, log_health, log_day_entry or log_meter_reading. Each shows a card the owner taps to save; never say it's saved before they do. Several things in one message ("slept 7 hours and ran 5k") go in one log_health call.`;

/** Prepares the card for the owner to confirm. Nothing is saved here: it only reads, to show what stays and what was used since. */
export async function runLogTool(name: string, raw: unknown, ctx: { confirm: (card: ConfirmCard) => void; now: Date; tz: string; money: boolean }): Promise<string> {
  const today = zonedToday(ctx.now, ctx.tz);
  let card: LogCard;
  if (name === "log_spending") {
    // Enforced here as well as by not offering it.
    if (!ctx.money) throw new Error(SPENDING_OFF);
    card = spendingCard(raw, { today });
  } else if (name === "log_health") {
    const date = (raw as { date?: unknown } | null)?.date;
    const before = await readSourceDay(typeof date === "string" && date ? date : today, MANUAL_HEALTH).catch(() => null);
    card = healthCard(raw, { today }, before);
  } else if (name === "log_day_entry") {
    card = entryCard(raw, { today });
  } else if (name === "log_meter_reading") {
    card = readingCard(raw, { today }, await loadReadings().catch(() => []));
  } else throw new Error(`Unknown tool ${name}`);
  ctx.confirm(card);
  const words = logWords(card);
  return JSON.stringify({ shown: WAITING, card: `${words.title} · ${words.meta}` });
}

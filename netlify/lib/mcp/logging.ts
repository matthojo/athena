/**
 * MCP tools for logging (docs/notes/ask-logging.md): spending, health
 * figures, a day's entry and a meter reading, as Ask logs them from a
 * sentence. An MCP client has no card to tap, so these save straight away,
 * through the same lib/ functions as the manual-entry routes. Health is laid
 * over what was typed in for the day (lib/ask-logging.ts mergeHealth), never
 * in place of it. There's no undo here: the owner removes a payment, an
 * entry or a reading from the app, and changes a day's health in its form.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Helpers, ToolResult } from "./results";
import { AthenaInputError } from "../../../lib/db";
import { LOG_ENTRY_KINDS, LogInputError, entryCard, healthCard, healthFigureWords, mergeHealth, readingCard, spendingCard } from "../../../lib/ask-logging";
import { MONEY_CATEGORIES } from "../../../lib/day-types";
import { zonedParts } from "../../../lib/dates";
import { addManualPayment } from "../../../lib/money";
import { HealthInputError, MANUAL_HEALTH, readHealthDay, readSourceDay, replaceManualHealthDay } from "../../../lib/health";
import { addManualEntry } from "../../../lib/days";
import { addReading, loadReadings } from "../../../lib/meter-readings";
import { ownerToday } from "../../../lib/trips";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, the owner's local day; today when left out");

/** The words a wrong field gets go back to the client as they are. */
async function fixable(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof LogInputError || error instanceof HealthInputError) throw new AthenaInputError(error.message);
    throw error;
  }
}

export function registerLoggingTools(server: McpServer, { ok, safe }: Helpers): void {
  server.tool(
    "log_spending",
    "Add a payment the owner made to Money, under “Added by hand”, for someone without a connected bank or a cash payment one missed. Added to a bank's day, never in place of it. " +
      "Saved straight away; the owner removes it from the Money page.",
    {
      amount: z.string().describe("What was spent, as said: “£4”, “4.50”, “€12”"),
      currency: z.string().optional().describe("Three letters, only when it isn't pounds and no symbol says so"),
      category: z.enum(MONEY_CATEGORIES).optional().describe("eating_out for cafés and restaurants; general when nothing fits"),
      what: z.string().max(120).optional().describe("What it was, or where: “Coffee”, “Corner shop”"),
      date,
    },
    safe((args) =>
      fixable(async () => {
        const { today, tz } = await ownerToday();
        const card = spendingCard(args, { today });
        const saved = await addManualPayment({ date: card.date, amount: card.amount, currency: card.currency, category: card.category, merchant: card.merchant }, { today, tz, nowTime: zonedParts(new Date(), tz).time.slice(0, 5) });
        return ok({ saved: "spending", id: saved.id, date: saved.date, amount_minor: saved.amount, currency: saved.currency, category: saved.category, ...(saved.merchant ? { what: saved.merchant } : {}) });
      }),
    ),
  );

  server.tool(
    "log_health",
    "Log health figures for a day, as the owner would type them on the Health page. Only the figures given change: what was typed in for that day before stays. " +
      "What's typed in wins over every app for the figures it has. Sleep goes on the day it ended (last night's sleep is today). A workout is added to the day's.",
    {
      date,
      sleep_hours: z.number().min(0).max(24).optional(),
      steps: z.number().int().min(0).optional(),
      weight_kg: z.number().optional(),
      resting_hr: z.number().int().optional(),
      workout: z.object({ type: z.string().describe("run, walk, ride, swim, strength, yoga, hiit or other"), minutes: z.number().int().min(1), km: z.number().min(0).optional() }).optional(),
      water_litres: z.number().min(0).optional(),
      coffees: z.number().int().min(0).optional().describe("Cups of coffee (95 mg each)"),
      alcohol_drinks: z.number().min(0).optional(),
      kcal: z.number().int().min(0).optional().describe("Calories eaten"),
      mindful_minutes: z.number().int().min(0).optional(),
    },
    safe((args) =>
      fixable(async () => {
        const { today, tz } = await ownerToday();
        const day = args.date ?? today;
        const before = await readSourceDay(day, MANUAL_HEALTH);
        const card = healthCard(args, { today }, before);
        const merged = mergeHealth(before, card.figures);
        await replaceManualHealthDay(readHealthDay({ ...merged, date: card.date, source: MANUAL_HEALTH }, { today, source: MANUAL_HEALTH }), { tz });
        return ok({ saved: "health", date: card.date, changed: healthFigureWords(card.figures), kept: card.keeps });
      }),
    ),
  );

  server.tool(
    "log_day_entry",
    "Add something the owner watched, listened to, read or played to a day in Days (source “manual”). It counts in Music, search and Ask like any source's entry. A workout goes in log_health instead.",
    {
      kind: z.enum(LOG_ENTRY_KINDS),
      title: z.string().min(1).max(300).describe("The film's, show's, album's, book's or game's name"),
      subtitle: z.string().max(300).optional().describe("Who made it, or which episode"),
      minutes: z.number().int().min(1).max(1440).optional(),
      date,
    },
    safe((args) =>
      fixable(async () => {
        const { today } = await ownerToday();
        const card = entryCard(args, { today });
        const r = await addManualEntry(card.date, card.entry, { today });
        return ok({ saved: "day entry", date: r.date, id: r.id, ...(r.id ? {} : { folded: "The day already had this from another source; they're shown as one." }) });
      }),
    ),
  );

  server.tool(
    "log_meter_reading",
    "Add an electricity or gas meter reading for House. The use between two readings is spread over the days between them as the home's days; a smart meter's day wins over them. One reading a meter a day: a second on the same day replaces the first.",
    {
      fuel: z.enum(["electricity", "gas"]),
      value: z.number().min(0).describe("The number on the meter"),
      unit: z.enum(["kwh", "m3", "ft3"]).optional().describe("Electricity is kWh. Gas: kwh, m3 (newer meters) or ft3 (older, hundreds of cubic feet); kwh when left out"),
      date,
    },
    safe((args) =>
      fixable(async () => {
        const { today, tz } = await ownerToday();
        const card = readingCard(args, { today }, await loadReadings());
        await addReading({ fuel: card.fuel, date: card.date, value: card.value, unit: card.unit }, { today, tz });
        return ok({ saved: "meter reading", fuel: card.fuel, date: card.date, value: card.value, unit: card.unit, ...(card.since ? { used_since: { date: card.since.date, kwh: card.since.kwh } } : {}) });
      }),
    ),
  );
}

/**
 * athena_receipt: the email collection hands Athena a ride or takeaway
 * receipt as it is, and lib/receipts.ts reads it. The model never writes the
 * fare, the total or an address: Athena takes them from the email and seals
 * them (lib/receipts-save.ts). Offered with the trip tools, to collections
 * that read email.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const RECEIPT_TOOL: Anthropic.Tool = {
  name: "athena_receipt",
  description:
    "Save a ride or takeaway receipt: Uber and Bolt rides, Uber Eats, Deliveroo and Just Eat orders, including a takeaway's \"on its way\" and \"delivered\" emails. " +
    "Pass the email as it is; Athena reads it. A ride goes on its day with where from and to and how long; a takeaway goes on its day with the restaurant and dishes, and into purchases. " +
    "Athena seals the fare or total and the ride's addresses itself. Saving the same email again changes nothing. " +
    "Returns saved, with what the day shows, or not_a_receipt: then carry on with the email as usual.",
  input_schema: {
    type: "object",
    properties: {
      external_id: { type: "string", description: "The email's thread or message id." },
      from: { type: "string", description: "The From header exactly as the email has it, with the address: \"Uber Receipts <noreply@uber.com>\"." },
      subject: { type: "string", description: "The subject line, as it is." },
      date: { type: "string", description: "When the email was sent, ISO 8601 with its offset or Z." },
      text: { type: "string", description: "The whole body, as the email tool gave it (plain text or HTML). Don't summarise or shorten it." },
    },
    required: ["external_id", "from", "subject", "date", "text"],
  },
};

export const receiptInput = z.object({
  external_id: z.string().min(1).max(500),
  from: z.string().min(3).max(320),
  subject: z.string().max(500),
  date: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "date: ISO 8601 with Z or an offset"),
  text: z.string().min(1).max(200_000),
});

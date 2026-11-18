// Shared by ask-import.test.ts and ask-import.db.test.ts: a Gmail account from before Athena collected
// (stubbed in its own shapes, with send and reply on its allowlist to prove they're never offered or run),
// and models scripted the way answer-lifelog.test.ts scripts them.
import assert from "node:assert/strict";
import type { Connector } from "../../../lib/connectors";
import type { Anthropic } from "../../../lib/ai";
import type { OpenConnector } from "./mcp-client";

export const NOW = new Date("2026-11-08T10:00:00Z");
export const TZ = "Europe/London";
export const THREAD = "18c0ffee5eed0001";
export const LINK = `https://mail.google.com/mail/?authuser=owner%40example.com#all/${THREAD}`;

const EMAIL = {
  id: THREAD,
  messages: [
    {
      from: "TAP Air Portugal <booking@flytap.com>",
      subject: "Your booking is confirmed: London to Lisbon, 14 January",
      date: "2025-12-02T18:20:00Z",
      plaintextBody:
        "Your booking is confirmed. Reference XK7P2Q. Outbound TP 1351 Wed 14 Jan 2026 09:40 London Heathrow T2 to Lisbon 12:30. Return TP 1350 Sun 18 Jan 2026 13:05 Lisbon to London Heathrow 15:50.",
    },
  ],
  viewUrl: LINK,
};

/** A connected Gmail account, added to Athena on 14 Sep 2026. `calls` records every tool it runs. */
export function gmailAccount(calls: string[], id = "6f1c0000-0000-4000-8000-00000000a001"): { c: Connector; open: OpenConnector } {
  const tool = (name: string, description: string) => ({ name, description, inputSchema: { type: "object", properties: {} } });
  const c = {
    id,
    name: "Gmail",
    provider: "gmail",
    account_label: "",
    status: "connected",
    scope: "",
    auth_type: "oauth",
    oauth: {},
    created_at: "2026-09-14T08:00:00Z",
    allowed_tools: ["search_threads", "get_thread", "send_message", "reply"],
  } as unknown as Connector;
  const open: OpenConnector = {
    connector: c,
    direct: {
      tools: [
        tool("search_threads", "Search Gmail threads."),
        tool("get_thread", "Read one thread."),
        tool("send_message", "Send an email."),
        tool("reply", "Reply to a thread."),
      ],
      async call(name: string, args: Record<string, unknown>) {
        calls.push(`${name} ${JSON.stringify(args)}`);
        if (name === "search_threads") return { text: JSON.stringify({ threads: [{ id: THREAD, subject: EMAIL.messages[0].subject, date: "2025-12-02", viewUrl: LINK }] }), isError: false };
        if (name === "get_thread") return { text: JSON.stringify(EMAIL), isError: false };
        return { text: "sent", isError: false };
      },
    } as never,
    close: async () => undefined,
  };
  return { c, open };
}

type Block = Record<string, unknown>;
const base = (n: number) => ({ id: `m${n}`, type: "message", role: "assistant", model: "test", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });

/** A model that answers each round with the blocks `rounds[i]` gives (from the tools it was offered and what it has seen), then stops. */
export function scripted(rounds: Array<(tools: string[], seen: string) => Block[]>) {
  const sent: Array<{ system: string; tools: string[]; messages: string }> = [];
  let round = 0;
  const client = {
    messages: {
      async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
        const tools = ((params.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
        const seen = JSON.stringify(params.messages);
        sent.push({ system: String(params.system), tools, messages: seen });
        const make = rounds[round];
        const n = round++;
        if (!make) return { ...base(n), stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } as unknown as Anthropic.Message;
        return { ...base(n), stop_reason: "tool_use", content: make(tools, seen) } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
  return { client, sent };
}

export const use = (tools: string[], suffix: string, input: Record<string, unknown>, id = suffix): Block => {
  const name = tools.find((t) => t === suffix || t.endsWith(`__${suffix}`));
  assert.ok(name, `offered ${suffix}: ${tools.join(", ")}`);
  return { type: "tool_use", id, name, input };
};

/** The answer: searches Gmail for January, then cites the booking email it found. */
export function answerModel() {
  return scripted([
    (tools) => [use(tools, "search_threads", { query: "flight after:2026/01/01 before:2026/02/01" })],
    (tools, seen) => {
      assert.ok(seen.includes(THREAD), "the search came back");
      return [
        use(tools, "answer", {
          text: "You flew to Lisbon on TAP on Wednesday 14 January and back on Sunday 18 January [1].",
          found: true,
          sources: [{ ref: LINK, title: "Your booking is confirmed: London to Lisbon", date: "2025-12-02" }],
        }),
      ];
    },
  ]);
}

const leg = (segment: string, title: string, start: string, from: string, to: string, end: string, confidence = 0.95) => ({
  external_id: THREAD,
  kind: "flight",
  title,
  provider: "TAP Air Portugal",
  reference: "XK7P2Q",
  segment,
  start_local: start,
  start_tz: from === "London" ? "Europe/London" : "Europe/Lisbon",
  start_city: from,
  end_local: end,
  end_tz: to === "London" ? "Europe/London" : "Europe/Lisbon",
  end_city: to,
  trip_destination: "Lisbon",
  email_link: LINK,
  quote: "Your booking is confirmed. Reference XK7P2Q.",
  confidence,
});

export const OUTBOUND = leg("outbound", "TP 1351", "2026-01-14T09:40", "London", "Lisbon", "2026-01-14T12:30");
export const RETURN = leg("return", "TP 1350", "2026-01-18T13:05", "Lisbon", "London", "2026-01-18T15:50");

/** The email-digest recipe on one item: reads the thread, saves both legs. `confidence` under 0.8 sends them to the Review inbox. */
export function collectorModel(confidence = 0.95) {
  return scripted([
    (tools) => [use(tools, "get_thread", { threadId: THREAD })],
    (tools, seen) => {
      assert.ok(seen.includes("XK7P2Q"), "read the email");
      return [use(tools, "athena_trip_booking", { ...OUTBOUND, confidence }, "out"), use(tools, "athena_trip_booking", { ...RETURN, confidence }, "ret")];
    },
  ]);
}

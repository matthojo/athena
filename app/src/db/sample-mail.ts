/**
 * Sample mode's Gmail account for "Emails Athena reads": one day of mail
 * (a domain reseller's customer orders that skip the inbox, receipts,
 * promotions, people), the account's labels, and rules already set up.
 * The preview is worked out here with the same rules the server uses.
 */
import { NO_RULES, passes, topSenders, type MailLabel, type MailPreview, type MailRules, type RuleMessage } from "../../../lib/mail-rules";
import type { MailRulesPort } from "../components/mail-rules";

const LABELS: MailLabel[] = [
  { id: "INBOX", name: "Inbox" },
  { id: "CATEGORY_PROMOTIONS", name: "Promotions" },
  { id: "CATEGORY_SOCIAL", name: "Social" },
  { id: "CATEGORY_UPDATES", name: "Updates" },
  { id: "CATEGORY_FORUMS", name: "Forums" },
  { id: "Label_3", name: "Name.com orders" },
  { id: "Label_4", name: "Newsletters" },
  { id: "Label_5", name: "Receipts" },
  { id: "Label_6", name: "Travel" },
];

/** The last 24 hours: 340 emails. */
function day(): RuleMessage[] {
  const out: RuleMessage[] = [];
  const add = (n: number, m: (i: number) => RuleMessage) => {
    for (let i = 0; i < n; i++) out.push(m(i));
  };
  // A filter files every customer order under a label and skips the inbox.
  add(280, (i) => ({ from: "Name.com <orders@name.com>", subject: `Domain purchase: order ${48210 + i}`, labels: ["Label_3"] }));
  add(18, (i) => ({ from: ["Uniqlo <news@uniqlo.com>", "Patagonia <hello@patagonia.com>", "Sonos <offers@sonos.com>"][i % 3], subject: "This week only", labels: ["INBOX", "CATEGORY_PROMOTIONS"] }));
  add(8, () => ({ from: "Namecheap <billing@namecheap.com>", subject: "Your domain renews soon", labels: ["INBOX", "CATEGORY_UPDATES"] }));
  add(6, (i) => ({ from: ["The Browser <editors@thebrowser.com>", "Stratechery <email@stratechery.com>"][i % 2], subject: "Weekly digest", labels: ["INBOX", "Label_4"] }));
  add(14, (i) => ({ from: "LinkedIn <messages-noreply@linkedin.com>", subject: i % 2 ? "You appeared in 9 searches" : "New message from Ana", labels: ["INBOX", "CATEGORY_SOCIAL"] }));
  add(14, (i) => ({ from: ["Priya <priya@hey.com>", "Sam Okafor <sam@okafor.studio>", "Mum <mum@example.com>", "Tom <tom@brightwater.co>"][i % 4], subject: ["Lunch Friday?", "Draft for review", "Sunday", "1:1 notes"][i % 4], labels: ["INBOX"] }));
  return out;
}

const SAMPLE_RULES: MailRules = {
  ...NO_RULES,
  inbox_only: true,
  skip_senders: ["namecheap.com"],
  skip_subjects: ["Weekly digest"],
  skip_labels: [{ id: "CATEGORY_PROMOTIONS", name: "Promotions" }],
};

export function sampleMailPort(): MailRulesPort {
  let rules = SAMPLE_RULES;
  const mail = day();
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    async load() {
      await wait(120);
      return { rules, skipped_week: 2047 };
    },
    async labels() {
      await wait(200);
      return LABELS;
    },
    async preview(next): Promise<MailPreview> {
      await wait(350);
      const kept = mail.filter((m) => passes(m, next)).length;
      return { hours: 24, total: mail.length, skipped: mail.length - kept, capped: false, suggestions: topSenders(mail, next, { own: "owner@gmail.com", min: 10 }) };
    },
    async save(next) {
      await wait(150);
      rules = next;
    },
  };
}

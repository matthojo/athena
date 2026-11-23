/**
 * The connected accounts an imported assistant or skill may open (lib/shared-limits.ts), for the tick rows on the
 * import sheet, an imported assistant's page and an imported skill's page; and the one-time notice naming imported
 * skills that lost their accounts. Sample mode has three made-up accounts and keeps its ticks in memory.
 */
import { fetchConnectors, isSampleMode, request } from "./api";
import { orderAccounts, type AccountRow } from "../../../lib/shared-limits";
import { isCustomServer } from "../../../lib/connector-presets";

export type { AccountRow };

/** Sample mode's accounts: the ones its sample data comes from. */
export const SAMPLE_ACCOUNTS: AccountRow[] = [
  { id: "5a3e0000-0000-4000-8000-0000000ac001", provider: "linear", name: "Linear", label: "work" },
  { id: "5a3e0000-0000-4000-8000-0000000ac002", provider: "gmail", name: "Gmail", label: "sam@example.com" },
  { id: "5a3e0000-0000-4000-8000-0000000ac003", provider: "google-calendar", name: "Google Calendar", label: "sam@example.com" },
];

/**
 * Every account a turn could open, the ones in `needs` (providers) first: a custom server only with "Use in Ask"
 * on, as the server lists them (lib/team-share-store.ts accountRows).
 */
export async function itemAccounts(needs: readonly string[] = []): Promise<AccountRow[]> {
  if (isSampleMode()) return orderAccounts(SAMPLE_ACCOUNTS, needs);
  const { connectors } = await fetchConnectors();
  const rows = connectors
    .filter((c) => !isCustomServer(c.provider) || (c as { use_in_ask?: boolean }).use_in_ask === true)
    .map((c) => ({ id: c.id, provider: c.provider, name: c.name, ...(c.account_label ? { label: c.account_label } : {}) }));
  return orderAccounts(rows, needs);
}

/** An imported skill the notice names. */
export interface NoticeSkill {
  id: string;
  name: string;
  title: string;
}

const SAMPLE_NOTICE_KEY = "athena.sample.accountsNotice";

/** The one-time notice: imported skills from before the update with no account ticked. Empty once it's read. */
export async function accountsNotice(sample: () => NoticeSkill[] = () => []): Promise<NoticeSkill[]> {
  if (isSampleMode()) {
    try {
      if (localStorage.getItem(SAMPLE_NOTICE_KEY) === "read") return [];
    } catch {
      // storage blocked: show it
    }
    return sample();
  }
  return (await request<{ skills: NoticeSkill[] }>("/skills/notice")).skills;
}

/** The owner read it: it doesn't come back. */
export async function dismissAccountsNotice(): Promise<void> {
  if (isSampleMode()) {
    try {
      localStorage.setItem(SAMPLE_NOTICE_KEY, "read");
    } catch {
      // storage blocked: gone for this visit
    }
    return;
  }
  await request<{ ok: true }>("/skills/notice", { method: "DELETE" });
}

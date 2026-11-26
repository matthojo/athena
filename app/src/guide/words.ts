/**
 * Every word the guided setup shows (app/src/guide/view.ts), in one place so
 * they can be read together and checked (words.test.ts). Plain and specific,
 * as lib/writing-style.ts asks: no filler, no em dashes, British English.
 */

import type { GuideStep } from "../../../lib/setup-guide";

/** The five steps the owner sees, in order, as the progress bar names them. Welcome is the first: it connects this device. */
export const STEP_NAMES: Record<Exclude<GuideStep, "done">, string> = {
  welcome: "Connect this device",
  site: "Check your site",
  about: "Your name",
  sources: "First sources",
  phone: "Your phone",
};

export const COUNTED: Exclude<GuideStep, "done">[] = ["welcome", "site", "about", "sources", "phone"];

/** "Step 2 of 5". */
export const stepOf = (step: GuideStep): string => {
  const i = COUNTED.indexOf(step as (typeof COUNTED)[number]);
  return i < 0 ? "" : `Step ${i + 1} of ${COUNTED.length}`;
};

export const WORDS = {
  back: "Back",
  next: "Continue",
  skip: "Skip for now",
  later: "Not now",

  welcome: {
    title: "Your Athena is live",
    lede: "It runs on your own Netlify site, and your data stays there. Five steps get it ready, and they take about ten minutes.",
    plan: [
      ["Connect this device", "With the access token you chose when you deployed."],
      ["Check your site", "Athena checks its settings and helps you add any that are missing."],
      ["Tell Athena your name", "For its greetings and your morning briefing."],
      ["Add your first sources", "Your calendar, email or work, so Home fills itself in."],
      ["Get it on your phone", "With notifications, if you want them."],
    ] as Array<[string, string]>,
    tokenLabel: "Access token",
    tokenPlaceholder: "Paste your access token",
    tokenHelpLead: "It's the ",
    tokenHelpTail: " you set when you deployed. If you marked it secret, Netlify won't show it again, so look where you saved it, such as your password manager.",
    start: "Connect and start",
    connecting: "Connecting…",
    resume: "Carry on",
    resumeLede: "This device is connected. Pick up where you left off.",
    foot: "This device gets its own key, which you can remove in Settings. The token you paste isn't kept.",
    empty: "Paste your token to continue.",
    refused: "That token wasn't accepted. Check it and try again.",
    unreachable: "Couldn't reach Athena. Check you're online and try again.",
  },

  site: {
    title: "Check your site",
    lede: "Athena reads these from your site's environment variables in Netlify. It sees whether each one is set, never its value.",
    fixTitle: "Athena needs a setting",
    fixLede: "One of the settings Athena runs on is missing from your site. Until it's back, some things won't work.",
    checking: "Checking your site…",
    offline: "Couldn't reach your site. Check you're online, then check again.",
    checkAgain: "Check again",
    database: { name: "Database", ok: "Connected", bad: "Not answering. Netlify sets it up on the first deploy. Start a new deploy and check again." },
    connectorKey: { name: "CONNECTOR_ENCRYPTION_KEY", ok: "Set", bad: "Missing. Add it in Netlify's environment variables as 64 random hex characters (openssl rand -hex 32), then deploy again." },
    ai: { name: "Claude, through Netlify AI Gateway", ok: "Ready", bad: "Not ready yet. It switches on after a production deploy on a credit-based Netlify plan. Ask and collections wait for it; everything else works now." },
    dataKey: { name: "ATHENA_DATA_KEY", ok: "Set", bad: "Not set yet", invalid: "Set, but it isn't a valid key. Replace it with the one below." },
    allSet: "Everything Athena needs is in place.",
    fixDone: "Back to Athena",
  },

  key: {
    title: "Add your data key",
    why: "Athena encrypts what you write with this key. Only your production site gets it, so deploy previews can't read your data.",
    warn: "Keep a copy somewhere safe. If you lose it, you lose your data, and nobody can get it back for you.",
    label: "Your data key",
    madeHere: "Made on this device just now. It isn't sent to Athena.",
    copy: "Copy",
    copied: "Copied",
    saved: "I've saved this key somewhere safe, like a password manager",
    stepsTitle: "Now add it in Netlify",
    steps: [
      ["Open your site's environment variables in Netlify.", "Open environment variables"],
      ["Add a variable named ATHENA_DATA_KEY and tick Contains secret values.", null],
      ["Give it a value for Production only: choose a different value for each deploy context, paste the key under Production and leave the rest empty.", null],
      ["Start a new deploy so the key reaches your site: Deploys, then Trigger deploy.", "Open deploys"],
    ] as Array<[string, string | null]>,
    done: "I've added it and started a deploy",
    waiting: "Waiting for the new deploy. This checks every few seconds; a deploy usually takes a minute or two.",
    checkNow: "Check now",
    set: "Your data key is set",
    matches: "It's the key you saved.",
    differs: "It's not the key shown here, so make sure you've kept a copy of the one you added.",
  },

  about: {
    title: "What should I call you?",
    lede: "Athena uses your name in greetings and in your morning briefing.",
    label: "Your name",
    placeholder: "Sam",
    zone: (zone: string) => `Your time zone is ${zone}, from this device. Briefings and reminders follow it.`,
    saveFailed: "Couldn't save your name. Check you're online and try again.",
  },

  sources: {
    title: "Add your first sources",
    lede: "Athena reads from the accounts you connect and keeps what matters as notes, to-dos and events. Start with one or two. You can add more any time in Settings, under Sources.",
    connectedLabel: "Connected",
    pickLabel: "What would you like Athena to keep?",
    browse: "Browse all services",
    more: (n: number) => `${n} more ideas`,
    fewer: "Fewer ideas",
    google: "Gmail and Google Calendar need a little setup in Google Cloud first. The service's page walks you through it.",
    shield: "Athena only reads. Sign-ins are kept encrypted on your site.",
    collecting: "Collecting",
    notCollecting: "Not collecting yet",
    sample: "Sample data can't connect accounts. On your own site, these open the sign-in for each service.",
    loadFailed: "Couldn't load your accounts. Check you're online and try again.",
  },

  phone: {
    title: "Put Athena on your phone",
    lede: "On your Home Screen, Athena opens like an app and can send you notifications.",
    elsewhereTitle: "On your phone",
    elsewhere: (site: string) => `Open ${site} in Safari or Chrome, type your site password, and paste your access token there too. Then add it to your Home Screen.`,
    copyLink: "Copy link",
    iosTitle: "Add it to your Home Screen",
    ios: "In Safari, tap Share, then Add to Home Screen. Open Athena from there and you'll be signed in.",
    installTitle: "Install Athena",
    install: "Install it as an app, so it opens in its own window.",
    installButton: "Install",
    installedTitle: "Athena is on this device",
    installed: "It opens like an app, from your Home Screen or dock.",
    notifyTitle: "Notifications on this device",
  },

  done: {
    title: "You're set up",
    lede: "What happens next",
    next: (sources: number) =>
      [
        sources
          ? ["Over the next hour", `Your ${sources === 1 ? "first source sends" : "sources send"} what's new. It shows up on Home as it arrives.`]
          : ["Whenever you're ready", "Add a source from Settings, under Sources, and Home starts filling itself in."],
        ["Tomorrow at 07:30", "Your first morning briefing: the day ahead, in a few lines."],
        ["Each morning", "Days keeps yesterday as a page, with what you did and who you saw."],
        ["In a week", "A look back at your first seven days."],
      ] as Array<[string, string]>,
    open: "Open Athena",
    summary: {
      device: "This device is connected",
      key: "Your data is encrypted",
      sources: (n: number) => (n === 1 ? "One source connected" : `${n} sources connected`),
      noSources: "No sources yet",
      notify: "Notifications are on",
    },
  },

  /** Said once in the app when a finished site loses a required setting. */
  nudge: { text: "Your site is missing a setting Athena needs", action: "Fix it" },

  /** For screenshots and review only: the sample preview at #/welcome. */
  samplePreview: "Sample data: nothing here is saved.",
};

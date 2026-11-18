/**
 * ElevenLabs in Settings → Voice: the voice Athena talks in (Ask's Talk)
 * and the ears for Talk and dictation, with the owner's own account.
 *
 * - voiceRow(): the "Voice" row in the list (or an invitation to set it up).
 * - voiceDetail(): the pane or sheet. Not connected, it explains where to
 *   get a key and takes one; connected, it shows the voice, this month's
 *   credits, a "Hear it" test, and how to replace or remove the key.
 * - The voice picker: a sheet of the account's voices, each with a short
 *   sample to listen to before choosing.
 *
 * The key goes to the server once and is never shown again; this device
 * only ever learns whether it's connected (db/voice-api.ts).
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { brandLogo } from "./brand-logo";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { confirmDialog } from "./confirm";
import { hueFor, initials, relativeTime } from "../lib/format";
import { errorText, statusLine, trail } from "../lib/connectors-ui";
import { unlockAudio } from "../lib/audio";
import { chooseVoice, connectElevenLabs, disconnectElevenLabs, fetchVoices, fetchVoiceStatus, setGeminiBackup, talkSpeak, VoiceApiError, type Voice, type VoiceStatus } from "../db/voice-api";
import "../styles/voice.css";

const KEYS_URL = "https://elevenlabs.io/app/settings/api-keys";
const SAMPLE_LINE = "Hi, I'm Athena. This is how I'll sound when we talk.";

// ---------- The row in the list ----------

export function voiceRow(s: VoiceStatus, selected: boolean, open: () => void): HTMLElement {
  if (!s.connected) {
    const b = h(
      "button",
      { class: "card conn-prompt voice-prompt", type: "button", "aria-current": selected ? "true" : undefined },
      brandLogo("elevenlabs", "md"),
      h("span", { class: "row__body" }, h("span", { class: "row__title" }, "Talk with Athena"), h("span", { class: "row__meta" }, "Add your ElevenLabs key to talk back and forth in Ask")),
      h("span", { class: "row__chevron" }, icons.chevronRight())
    );
    b.addEventListener("click", open);
    return b;
  }
  const b = h(
    "button",
    { class: "row conn-row", type: "button", "aria-current": selected ? "true" : undefined },
    brandLogo("elevenlabs", "md"),
    h("span", { class: "row__body" }, h("span", { class: "row__title" }, "ElevenLabs"), h("span", { class: "row__meta" }, ["Talk and dictation", s.voice?.name].filter(Boolean).join(" · "))),
    trail(s.status === "key_rejected" ? statusLine("warn", "Key rejected", "conn-status--compact") : null)
  );
  b.addEventListener("click", open);
  return h("div", { class: "card card--flush list" }, b);
}

// ---------- Small builders ----------

const group = (label: string | null, ...children: Array<HTMLElement | null>) =>
  h("section", { class: "group" }, label ? h("h3", { class: "group__label" }, label) : null, ...children);

const fact = (label: string, value: string | HTMLElement) =>
  h("div", { class: "prop prop--fact" }, h("span", { class: "prop__label" }, label), h("span", { class: "prop__value" }, value));

function action(icon: IconName, label: string, run: () => void | Promise<void>, opts: { danger?: boolean } = {}): HTMLButtonElement {
  const b = h(
    "button",
    { class: `profile__action${opts.danger ? " profile__action--muted profile__action--danger" : ""}`, type: "button" },
    h("span", { class: "profile__action-icon" }, icons[icon]()),
    h("span", { class: "profile__action-label" }, label)
  ) as HTMLButtonElement;
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await run();
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

/** A voice's face in a list: its initials on a hue from its name, like a person's. */
const voiceAvatar = (v: Pick<Voice, "name">) => h("span", { class: "avatar avatar--row", style: `--h:${hueFor(v.name)}`, "aria-hidden": "true" }, initials(v.name));

const numberFmt = new Intl.NumberFormat("en-GB");
const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" });

// ---------- Hearing a voice ----------

/** What's playing now (a sample or a test line), so starting another stops it. */
let playing: { stop: () => void } | null = null;

export function stopVoiceSample(): void {
  playing?.stop();
  playing = null;
}

/**
 * Play a voice: ElevenLabs' own sample when it has one (free, instant), or
 * otherwise (and for "Hear it") a line spoken with the real model, which
 * uses a few credits. Call from the tap itself so iOS allows the sound.
 */
export function playVoice(opts: { voiceId?: string; previewUrl?: string | null; real?: boolean; onEnd: () => void }): void {
  stopVoiceSample();
  let ended = false;
  const abort = new AbortController();
  let stopSound: () => void = () => abort.abort();
  const handle = {
    stop: () => {
      stopSound();
      finish();
    },
  };
  const finish = () => {
    if (ended) return;
    ended = true;
    if (playing === handle) playing = null;
    opts.onEnd();
  };
  playing = handle;

  if (opts.previewUrl && !opts.real) {
    const audio = new Audio(opts.previewUrl);
    stopSound = () => audio.pause();
    audio.addEventListener("ended", finish);
    audio.addEventListener("error", () => {
      if (!ended) showToast("Couldn't play that sample", { icon: "close" });
      finish();
    });
    void audio.play().catch(() => finish());
    return;
  }
  const ctx = unlockAudio();
  if (!ctx) {
    showToast("This browser can't play speech", { icon: "close" });
    finish();
    return;
  }
  void (async () => {
    try {
      const [{ body, sampleRate }, { playPcmStream }] = await Promise.all([talkSpeak(SAMPLE_LINE, { voiceId: opts.voiceId, signal: abort.signal }), import("../talk/player")]);
      if (ended) return;
      const p = playPcmStream(ctx, body, sampleRate);
      stopSound = () => {
        abort.abort();
        p.stop();
      };
      await p.done;
    } catch (error) {
      if (!ended && (error as { name?: string })?.name !== "AbortError") showToast(errorText(error, "Couldn't play that voice"), { icon: "close", timeoutMs: 6000 });
    } finally {
      finish();
    }
  })();
}

// ---------- The detail ----------

export interface VoiceDetailContext {
  /** The connection changed (connected, voice picked, removed): repaint the list. */
  changed: (s: VoiceStatus) => void;
}

export interface VoiceDetailView {
  el: HTMLElement;
  id: string;
  destroy: () => void;
}

export function voiceDetail(ctx: VoiceDetailContext): VoiceDetailView {
  const el = h("div", { class: "note profile conn-detail voice-detail" });
  let destroyed = false;
  let status: VoiceStatus | null = null;

  function skeleton() {
    el.replaceChildren(
      h(
        "header",
        { class: "profile__hero conn-hero" },
        brandLogo("elevenlabs", "lg"),
        h("span", { class: "skeleton", style: "height:22px;width:140px" }),
        h("span", { class: "skeleton", style: "height:14px;width:200px" })
      )
    );
  }

  async function load(withUsage = true) {
    try {
      const s = await fetchVoiceStatus(withUsage);
      if (destroyed) return;
      status = s;
      paint();
    } catch (error) {
      if (destroyed) return;
      el.replaceChildren(
        h(
          "div",
          { class: "card empty conn-empty" },
          h("span", { class: "tile" }, icons[navigator.onLine ? "plug" : "wifiOff"]()),
          h("p", { class: "empty__title" }, navigator.onLine ? "Couldn't load ElevenLabs" : "This needs a connection"),
          h("p", { class: "empty__sub" }, navigator.onLine ? errorText(error, "Try again in a moment.") : "The key lives on Athena's server. Try again when you're online.")
        )
      );
    }
  }

  function update(s: VoiceStatus) {
    // A reply without usage (picking a voice) keeps what's shown; one with usage replaces it, problem and all.
    const next: VoiceStatus = { ...status, ...s };
    if ("usage" in s) next.usage_problem = s.usage_problem;
    if (!s.connected) {
      next.usage = undefined;
      next.usage_problem = undefined;
    }
    status = next;
    ctx.changed(status);
    paint();
  }

  function paint() {
    if (!status) return;
    const top = el.closest(".sheet__scroll, .notes__pane")?.scrollTop ?? 0;
    el.replaceChildren(...(status.connected ? connectedView(status) : setupView(status)));
    el.closest(".sheet__scroll, .notes__pane")?.scrollTo({ top });
  }

  // ----- Not connected: how to get a key, and a place to paste it -----
  function setupView(s: VoiceStatus): HTMLElement[] {
    const key = h("input", {
      class: "prop__input",
      id: "elevenlabs-key",
      type: "password",
      placeholder: "Paste it here",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      enterkeyhint: "done",
    }) as HTMLInputElement;
    const error = h("p", { class: "form__error", role: "alert" });
    const submit = h("button", { class: "btn btn--primary btn--block", type: "submit" }, "Connect ElevenLabs") as HTMLButtonElement;
    const form = h(
      "form",
      // voice-form--clear: room under the button, so the tab bar never covers it (styles/sources.css).
      { class: "voice-form voice-form--clear" },
      h("div", { class: "card card--flush fields" }, h("div", { class: "prop" }, h("label", { class: "prop__label", for: key.id }, "API key"), h("span", { class: "prop__control" }, key))),
      error,
      submit
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.textContent = "";
      if (!key.value.trim()) {
        error.textContent = "Paste your ElevenLabs API key first.";
        key.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = "Checking the key…";
      try {
        const connected = await connectElevenLabs(key.value.trim());
        key.value = "";
        if (destroyed) return;
        update(connected);
        showToast(connected.voice ? `ElevenLabs is connected. Athena will speak as ${connected.voice.name}` : "ElevenLabs is connected", { icon: "check", timeoutMs: 5000 });
      } catch (err) {
        error.textContent = errorText(err, "Couldn't connect ElevenLabs. Try again in a moment.");
        submit.disabled = false;
        submit.textContent = "Connect ElevenLabs";
      }
    });

    const step = (n: number, body: Array<string | HTMLElement>) => h("li", { class: "voice-step" }, h("span", { class: "voice-step__n", "aria-hidden": "true" }, String(n)), h("span", { class: "voice-step__body" }, ...body));
    const openLink = h("a", { class: "prop__link", href: KEYS_URL, target: "_blank", rel: "noopener noreferrer" }, "Open ElevenLabs");

    return [
      h(
        "header",
        { class: "profile__hero conn-hero" },
        brandLogo("elevenlabs", "lg"),
        h("h2", { class: "page-title profile__name" }, "ElevenLabs"),
        h("p", { class: "profile__sub" }, "Talk with Athena, out loud"),
        statusLine("muted", "Not connected")
      ),
      !s.setup.encryption
        ? h(
            "div",
            { class: "conn-callout conn-callout--warn" },
            h("span", { class: "conn-callout__icon" }, icons.bell()),
            h("div", { class: "conn-callout__body" }, h("p", { class: "conn-callout__title" }, "Finish setting up"), h("p", { class: "conn-callout__sub" }, "Athena's server needs CONNECTOR_ENCRYPTION_KEY before it can keep a key. The README's Connectors section has the command."))
          )
        : null,
      h(
        "p",
        { class: "voice-intro" },
        "With your own ElevenLabs account you can talk with Athena in Ask: you speak, Athena answers out loud, and it keeps listening until you end it. Dictation in notes uses it too."
      ),
      group(
        "Get a key",
        h(
          "ol",
          { class: "card voice-steps" },
          step(1, ["Sign in to ElevenLabs and open API keys. ", openLink]),
          step(2, ["Create a key. If you restrict it, allow Text to Speech, Speech to Text, Voices and User (read), and leave the IP allowlist off."]),
          step(3, ["Copy the key and paste it below."])
        )
      ),
      form,
      h("p", { class: "conn-foot" }, icons.check(), "Kept encrypted on Athena's server, never on this device."),
    ].filter((x): x is HTMLElement => !!x);
  }

  // ----- Connected -----
  /** Dictation's fallback when ElevenLabs can't write something down: Gemini through Netlify, or nothing. */
  function backupGroup(s: VoiceStatus): HTMLElement {
    const sw = h("input", { type: "checkbox", role: "switch", class: "switch", "aria-label": "Use Gemini if ElevenLabs fails" }) as HTMLInputElement;
    sw.checked = s.gemini_backup;
    sw.addEventListener("change", async () => {
      const on = sw.checked;
      sw.disabled = true;
      try {
        update(await setGeminiBackup(on));
        showToast(on ? "Gemini backup on" : "Gemini backup off", { icon: "check" });
      } catch (err) {
        sw.checked = !on;
        showToast(errorText(err, "Couldn't change that"), { icon: "close" });
      } finally {
        sw.disabled = false;
      }
    });
    return group(
      "Backup",
      h(
        "div",
        { class: "card card--flush list" },
        h(
          "div",
          { class: "row" },
          h("span", { class: "tile tile--sm" }, icons.mic()),
          h("span", { class: "row__body" }, h("span", { class: "row__title" }, "Use Gemini if ElevenLabs fails"), h("span", { class: "row__meta" }, "Dictation keeps working through Netlify")),
          sw
        )
      ),
      h(
        "p",
        { class: "form__hint" },
        s.gemini_backup
          ? "If ElevenLabs can't write down a dictation, Athena sends that recording to Gemini through Netlify instead. Turn this off to keep your voice with ElevenLabs only."
          : "Your voice only goes to ElevenLabs. If it can't write something down, Athena tells you so you can try again."
      )
    );
  }

  function connectedView(s: VoiceStatus): HTMLElement[] {
    const rejected = s.status === "key_rejected";
    const outOfCredits = s.usage_problem === "no_credits" || (!!s.usage && s.usage.limit > 0 && s.usage.used >= s.usage.limit);

    const hearBtn = action("play", "Hear it", () => {
      if (!s.voice) return;
      hearBtn.classList.add("is-playing");
      hearBtn.querySelector(".profile__action-label")!.textContent = "Playing…";
      playVoice({
        voiceId: s.voice.id,
        real: true,
        onEnd: () => {
          hearBtn.classList.remove("is-playing");
          const label = hearBtn.querySelector(".profile__action-label");
          if (label) label.textContent = "Hear it";
        },
      });
    });
    hearBtn.disabled = !s.voice || rejected;

    const replaceKey = () => {
      status = { ...s, connected: false, status: "not_connected" };
      // Shown in place; the stored key stays until a new one is accepted.
      el.replaceChildren(...setupView(status), cancelReplace());
      el.querySelector<HTMLInputElement>("#elevenlabs-key")?.focus();
    };
    const cancelReplace = () => {
      const b = h("button", { class: "btn btn--ghost btn--block", type: "button" }, "Keep the current key");
      b.addEventListener("click", () => {
        status = s;
        paint();
      });
      return b;
    };

    async function remove() {
      const ok = await confirmDialog({
        title: "Remove ElevenLabs?",
        body: "Athena forgets your key and stops using ElevenLabs. Talk won't work until you add a key again, and dictation goes back to Athena's built-in transcription. To revoke the key completely, delete it in ElevenLabs too.",
        confirmLabel: "Remove",
        danger: true,
      });
      if (!ok) return;
      try {
        stopVoiceSample();
        update(await disconnectElevenLabs());
        showToast("ElevenLabs removed", { icon: "trash" });
      } catch (err) {
        showToast(errorText(err, "Couldn't remove it"), { icon: "close" });
      }
    }

    const voiceBtn = h(
      "button",
      { class: "row voice-current", type: "button" },
      s.voice ? voiceAvatar(s.voice) : h("span", { class: "tile tile--sm" }, icons.person()),
      h("span", { class: "row__body" }, h("span", { class: "row__title" }, s.voice?.name ?? "Pick a voice"), h("span", { class: "row__meta" }, s.voice ? "Athena's voice in Talk" : "Athena needs a voice to talk")),
      trail(h("span", { class: "row__meta" }, "Change"))
    );
    voiceBtn.addEventListener("click", () => openVoicePicker(s.voice?.id ?? null, (next) => update(next)));

    const usage = s.usage;
    const usageGroup = usage
      ? group(
          "This month",
          h(
            "div",
            { class: "card card--flush fields" },
            h(
              "div",
              { class: "prop prop--fact voice-usage" },
              h("span", { class: "prop__label" }, "Credits used"),
              h(
                "span",
                { class: "prop__value" },
                h("span", { class: "voice-usage__text" }, `${numberFmt.format(usage.used)} of ${numberFmt.format(usage.limit)}`),
                h(
                  "span",
                  {
                    class: `voice-usage__meter${outOfCredits ? " is-full" : ""}`,
                    role: "meter",
                    "aria-label": "Credits used this month",
                    "aria-valuemin": "0",
                    "aria-valuemax": String(usage.limit),
                    "aria-valuenow": String(Math.min(usage.used, usage.limit)),
                  },
                  h("span", { style: `width:${usage.limit ? Math.min(100, (usage.used / usage.limit) * 100).toFixed(1) : 0}%` })
                )
              )
            ),
            usage.resets_at ? fact("Resets", dayFmt.format(new Date(usage.resets_at))) : null,
            usage.tier ? fact("Plan", usage.tier.charAt(0).toUpperCase() + usage.tier.slice(1).replace(/_/g, " ")) : null
          ),
          h("p", { class: "form__hint" }, "Each character Athena says uses a credit. Listening is billed by the minute.")
        )
      : null;

    const callout =
      rejected || outOfCredits
        ? h(
            "div",
            { class: `conn-callout conn-callout--${rejected ? "warn" : "bad"}` },
            h("span", { class: "conn-callout__icon" }, icons[rejected ? "plug" : "clock"]()),
            h(
              "div",
              { class: "conn-callout__body" },
              h("p", { class: "conn-callout__title" }, rejected ? "ElevenLabs refused the key" : "Out of credits this month"),
              h("p", { class: "conn-callout__sub" }, rejected ? "It may have been deleted or changed in ElevenLabs. Paste a new one to keep talking." : "Talk works again when your plan renews, or after you add credits in ElevenLabs.")
            ),
            rejected
              ? (() => {
                  const b = h("button", { class: "btn btn--primary btn--sm", type: "button" }, "Replace key");
                  b.addEventListener("click", replaceKey);
                  return b;
                })()
              : null
          )
        : null;

    return [
      h(
        "header",
        { class: "profile__hero conn-hero" },
        brandLogo("elevenlabs", "lg"),
        h("h2", { class: "page-title profile__name" }, "ElevenLabs"),
        h("p", { class: "profile__sub" }, "Athena's voice for Talk and dictation"),
        statusLine(rejected ? "warn" : "good", rejected ? "Key rejected" : "Connected")
      ),
      callout,
      h(
        "div",
        { class: "profile__actions", role: "group", "aria-label": "ElevenLabs actions" },
        hearBtn,
        action("person", "Voice", () => openVoicePicker(s.voice?.id ?? null, (next) => update(next))),
        action("plug", "New key", replaceKey),
        action("trash", "Remove", remove, { danger: true })
      ),
      group("Voice", h("div", { class: "card card--flush list" }, voiceBtn)),
      usageGroup,
      backupGroup(s),
      group(
        "Details",
        h(
          "div",
          { class: "card card--flush fields" },
          fact("Speaks with", s.models.speech),
          fact("Listens with", s.models.listening),
          s.connected_at ? fact("Added", relativeTime(s.connected_at)) : null
        ),
        h("p", { class: "form__hint" }, "While you talk, your voice goes to ElevenLabs to be written down, and Athena's replies go there to be spoken. Nothing is sent when Talk is off.")
      ),
      h("p", { class: "conn-foot" }, icons.check(), "Your key is kept encrypted on Athena's server. This device never holds it."),
    ].filter((x): x is HTMLElement => !!x);
  }

  skeleton();
  void load();
  return {
    el,
    id: "elevenlabs",
    destroy() {
      destroyed = true;
      stopVoiceSample();
    },
  };
}

// ---------- The voice picker ----------

export function openVoicePicker(currentId: string | null, chosen: (s: VoiceStatus) => void): void {
  let selected = currentId;
  let voices: Voice[] = [];
  const list = h("div", { class: "voice-picker__list" }, h("div", { class: "card card--flush list" }, ...[0, 1, 2, 3].map(() => h("div", { class: "row" }, h("span", { class: "skeleton", style: "height:36px;width:36px;border-radius:50%" }), h("span", { class: "row__body" }, h("span", { class: "skeleton", style: "height:12px;width:40%" }), h("span", { class: "skeleton", style: "height:10px;width:60%;margin-top:6px" })), h("span", {})))));
  const search = h("input", { type: "search", placeholder: "Search voices", autocomplete: "off", "aria-label": "Search voices", enterkeyhint: "search" }) as HTMLInputElement;
  const searchBox = h("label", { class: "search voice-picker__search", hidden: true }, icons.search(), search);
  const body = h("div", { class: "voice-picker" }, h("p", { class: "form__hint voice-picker__hint" }, "Play a voice to hear it, then tap its name to use it."), searchBox, list);
  const sheet = openSheet({
    label: "Choose a voice",
    title: "Choose a voice",
    body,
    variant: "tall",
    onClose: () => stopVoiceSample(),
  });

  /** Which play button is showing "stop". */
  let playingId: string | null = null;

  function row(v: Voice): HTMLElement {
    const isSel = v.id === selected;
    const isPlaying = v.id === playingId;
    const play = h(
      "button",
      { class: `voice-play${isPlaying ? " is-playing" : ""}`, type: "button", "aria-label": isPlaying ? `Stop ${v.name}` : `Hear ${v.name}` },
      icons[isPlaying ? "close" : "play"]()
    ) as HTMLButtonElement;
    play.addEventListener("click", () => {
      if (playingId === v.id) {
        stopVoiceSample();
        return;
      }
      playingId = v.id;
      paint();
      playVoice({
        voiceId: v.id,
        previewUrl: v.preview_url,
        onEnd: () => {
          if (playingId === v.id) playingId = null;
          paint();
        },
      });
    });
    const pick = h(
      "button",
      { class: "voice-row__pick", type: "button", "aria-pressed": String(isSel) },
      h("span", { class: "row__body" }, h("span", { class: "row__title" }, v.name), h("span", { class: "row__meta" }, v.traits || (v.mine ? "Your voice" : "ElevenLabs voice"))),
      isSel ? h("span", { class: "voice-row__check", "aria-hidden": "true" }, icons.check()) : h("span", {})
    );
    pick.addEventListener("click", async () => {
      if (selected === v.id) return;
      const before = selected;
      selected = v.id;
      paint();
      try {
        const s = await chooseVoice(v.id);
        chosen(s);
        showToast(`Athena will speak as ${v.name}`, { icon: "check" });
      } catch (err) {
        selected = before;
        paint();
        showToast(errorText(err, "Couldn't change the voice"), { icon: "close", timeoutMs: 6000 });
      }
    });
    return h("div", { class: `row voice-row${isSel ? " is-selected" : ""}` }, play, pick);
  }

  function paint() {
    const q = search.value.trim().toLowerCase();
    const shown = voices.filter((v) => !q || `${v.name} ${v.traits}`.toLowerCase().includes(q));
    const mine = shown.filter((v) => v.mine);
    const stock = shown.filter((v) => !v.mine);
    const section = (label: string, items: Voice[]) => (items.length ? group(label, h("div", { class: "card card--flush list" }, ...items.map(row))) : null);
    list.replaceChildren(
      ...[
        section("Your voices", mine),
        section(mine.length ? "ElevenLabs voices" : "Voices", stock),
        shown.length ? null : h("p", { class: "form__hint" }, q ? `No voice matches “${search.value.trim()}”.` : "This account has no voices yet. Add one in ElevenLabs, then come back."),
        voices.some((v) => !v.preview_url)
          ? h("p", { class: "form__hint" }, "ElevenLabs' samples are free to play. A voice without one speaks a short line instead, which uses a few credits.")
          : null,
      ].filter((x): x is HTMLElement => !!x)
    );
  }

  search.addEventListener("input", paint);
  void fetchVoices()
    .then((r) => {
      voices = r.voices;
      selected = r.selected ?? selected;
      searchBox.hidden = voices.length <= 8;
      paint();
    })
    .catch((err) => {
      list.replaceChildren(
        h("div", { class: "card empty conn-empty" }, h("span", { class: "tile" }, icons.plug()), h("p", { class: "empty__title" }, "Couldn't load your voices"), h("p", { class: "empty__sub" }, err instanceof VoiceApiError ? err.message : "Try again in a moment."))
      );
    });
  void sheet;
}

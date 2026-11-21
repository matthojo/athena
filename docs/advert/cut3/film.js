/* Athena launch film, cut 3: "Athena remembers the rest".
 *
 * One continuous take. Everything on the 1920x1080 stage is computed from `ms`:
 *   window.seek(ms) -> Promise that resolves once that frame is fully drawn.
 * The world is a wall of screen cards in world units (1 unit = 1 CSS px of the 390-wide app).
 * A camera {x, y, z} (z = film px per world unit) is keyframed in time; a pointer leads it.
 * Timing and push-in targets come from the capture manifest, with fallbacks so the same code
 * works before the captures land (it then shows the look/*.png stills).
 */
(() => {
  "use strict";

  const W = 1920, H = 1080, FPS = 30;
  const FILM = "/tmp/claude-0/-home-user-athena/92254b34-7623-59d6-a458-adb54d88ca12/scratchpad/film";
  const q = new URLSearchParams(location.search);
  const CFG = Object.assign(
    { cap: q.get("cap") || "file://" + FILM + "/cap", look: q.get("look") || "file://" + FILM + "/../look", manifest: null },
    window.__FILM_CFG__ || {}
  );

  // ---------- maths ----------
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, p) => a + (b - a) * p;
  const prog = (t, a, b) => clamp((t - a) / (b - a));
  const inOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const inOutSoft = (p) => p * p * (3 - 2 * p);
  const inOutStrong = (p) => (p < 0.5 ? 16 * p * p * p * p * p : 1 - Math.pow(-2 * p + 2, 5) / 2);
  const outExpo = (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));
  const inCubic = (p) => p * p * p;
  const $ = (id) => document.getElementById(id);

  // ---------- timeline constants (ms) ----------
  const BEAT = 600;
  const T = {
    orbPop: 1200, orbPress: 2400, tile0: 3000, line1: 6000, dive: 9600, diveEnd: 11400,
    home: 12000, ask: 18000, saved: 28800, music: 34800, habits: 40800, health: 44400,
    pull: 48000, pullStart: 47400, pullEnd: 49800, wallFall: 52620, fall: 52800, line2: 53010,
    lift: 61200, lifted: 61800, great: 62400, // lift and lifted follow the "final" entry of swaps.json at load
    lockup: 64800, fade: 66900, end: 67200,
  };
  window.FILM_DURATION_MS = T.end;
  const SHOT_START = { home: T.home, ask: T.ask, saved: T.saved, music: T.music, habits: T.habits, health: T.health, graph: T.pull };

  // ---------- the wall ----------
  const CW = 390, CH = 844, GAP = 200, PITCH_X = CW + GAP, ROW2 = CH + GAP;
  // Twelve screens, six over six, rows aligned (with the 200-unit gaps the wall is almost exactly 16:9).
  // Top row in camera-travel order; `shot` cards play a capture, the rest are stills. `look` names the stand-in still.
  const TOP = ["home", "ask", "saved", "music", "habits", "health"];
  const BOTTOM = ["days", "week", "trips", "money", "watch", "graph"];
  const SHOTS = new Set(["home", "ask", "saved", "music", "habits", "health", "graph"]);
  const LOOK = { watch: "library" };
  const CARDS = {};
  TOP.forEach((n, i) => (CARDS[n] = { name: n, x: i * PITCH_X, y: 0, col: i, row: 0, shot: SHOTS.has(n) }));
  BOTTOM.forEach((n, i) => (CARDS[n] = { name: n, x: i * PITCH_X, y: ROW2, col: i, row: 1, shot: SHOTS.has(n) }));
  const WALL = { cx: (5 * PITCH_X + CW) / 2, cy: (ROW2 + CH) / 2, w: 5 * PITCH_X + CW, h: ROW2 + CH };

  // ---------- manifest, with fallbacks measured from the reference stills ----------
  let M = {};
  const FALLBACK_RECTS = {
    home: { greeting: { x: 16, y: 96, w: 330, h: 124 }, travelCard: { x: 16, y: 241, w: 358, h: 599 }, lateChip: { x: 81, y: 377, w: 187.5, h: 26 } },
    ask: { input: { x: 63, y: 681, w: 200, h: 44 }, send: { x: 323, y: 681, w: 44, h: 44 }, answer: { x: 71, y: 217, w: 286, h: 423 }, sources: { x: 71, y: 427, w: 286, h: 213 } },
    saved: { input: { x: 16, y: 240, w: 358, h: 44 }, newCard: { x: 16, y: 403, w: 174, h: 117 } },
    music: { playlists: { x: 16, y: 430, w: 358, h: 300 }, tile: { x: 16, y: 470, w: 170, h: 170 }, sheet: { x: 0, y: 190, w: 390, h: 654 } },
    habits: { tick: { x: 26, y: 318, w: 46, h: 46 } },
    health: { sleepCard: { x: 16, y: 300, w: 358, h: 420 } },
    // Measured on look/days.png: the "How's today going?" label and its row of five.
    checkin: { card: { x: 33, y: 462, w: 324, h: 95 }, great: { x: 297, y: 493, w: 60, h: 65 } },
  };
  const FALLBACK_EVENTS = { ask: { typeStart: 600, send: 3000, answer: 6000, answerDone: 9600 }, saved: { typeStart: 400, add: 2800 }, habits: { tick: 1200 }, checkin: { press: 1200 } };
  const rect = (shot, name) => (M[shot] && M[shot].rects && M[shot].rects[name]) || FALLBACK_RECTS[shot][name];
  // Capture-local time of an event.
  const capEv = (shot, name) => {
    const v = M[shot] && M[shot].events && M[shot].events[name];
    return typeof v === "number" ? v : FALLBACK_EVENTS[shot][name];
  };
  // An event the capture may or may not have: its film time, or null.
  const evOpt = (shot, name) => {
    const v = M[shot] && M[shot].events && M[shot].events[name];
    return typeof v === "number" ? SHOT_START[shot] + v : null;
  };
  // Ask is time-remapped so the answer finishes on screen: typing and send play at 1x, the steps tick
  // quickly so the first answer words land at film-local 5400 (23400), the answer streams out by 8400 (26400).
  const ASK_ANS = 5400, ASK_DONE = 8400;
  function askCapTime(local) {
    const send = capEv("ask", "send"), ans = Math.max(capEv("ask", "answer"), send + 1), done = Math.max(capEv("ask", "answerDone"), ans + 1);
    if (local <= send) return local;
    if (local <= ASK_ANS) return lerp(send, ans, (local - send) / (ASK_ANS - send));
    if (local <= ASK_DONE) return lerp(ans, done, (local - ASK_ANS) / (ASK_DONE - ASK_ANS));
    return done + (local - ASK_DONE);
  }
  // Film time of an event.
  const ev = (shot, name) => {
    if (shot === "ask" && name === "answer") return SHOT_START.ask + ASK_ANS;
    if (shot === "ask" && name === "answerDone") return SHOT_START.ask + ASK_DONE;
    return SHOT_START[shot] + capEv(shot, name);
  };
  const mid = (r) => [r.x + r.w / 2, r.y + r.h / 2];

  // ---------- camera ----------
  // Keyframes {t, x, y, z, ease}. `ease` shapes the move INTO that keyframe.
  let CAM = [];
  const camFit = (r, maxW, maxH, lo, hi) => clamp(Math.min(maxW / r.w, maxH / r.h), lo, hi);
  function buildCamera() {
    const c = (name, x, y, z) => ({ x: CARDS[name].x + x, y: CARDS[name].y + y, z });
    const k = [];
    const add = (t, pose, ease) => k.push(Object.assign({ t, ease: ease || inOut }, pose));
    const hold = (t, dz = 1.025, dy = 0) => { const p = k[k.length - 1]; add(t, { x: p.x, y: p.y + dy, z: p.z * dz }, (p) => p); };

    // 1-2: the wall is not there yet; the camera waits where tile 1 is the Home card in miniature.
    const z0 = TILE.size / CW;
    const far = { x: CARDS.home.x + CW / 2 - (tileX(0, 8) - W / 2) / z0, y: CARDS.home.y + CH / 2 - (TILE.y - H / 2) / z0, z: z0 };
    add(0, far);
    add(T.dive, far, (p) => p);
    // 3: dive in to the greeting.
    const greet = rect("home", "greeting"), travel = rect("home", "travelCard"), chip = rect("home", "lateChip");
    add(T.diveEnd, c("home", CW / 2, greet.y + greet.h / 2 + 22, 2.6), inOutStrong);
    hold(12600, 1.02, 8);
    // 4: morning. Straight down and in on the late row, landed by 15000; hold; leave.
    add(15000, c("home", CW / 2, chip.y + chip.h / 2 + 6, 3.6));
    hold(T.ask - 600, 1.03);
    // 5: Ask. Close on the field while the question types, back and up as it sends, in on the answer
    // as it starts, then settle where the answer and its sources are both readable.
    const tSend = ev("ask", "send"), tAns = ev("ask", "answer"), tDone = ev("ask", "answerDone");
    const input = rect("ask", "input"), ans = rect("ask", "answer");
    add(T.ask + 600, c("ask", CW / 2, input.y + input.h / 2 - 58, 2.9));
    hold(tSend, 1.02);
    add(tSend + 1500, c("ask", CW / 2, clamp(ans.y + 90, 250, 594), 2.1));
    hold(tAns, 1.015);
    add(tAns + 1200, c("ask", CW / 2, ans.y + 74, 2.9));
    hold(tAns + 1500, 1.004);
    add(tDone, c("ask", CW / 2, ans.y + ans.h / 2, camFit(ans, 1500, 930, 1.9, 3.0)), inOutSoft);
    hold(T.saved - 600, 1.03);
    // 6: Saved. Arrive on the field, ease in on the new card.
    const tAdd = ev("saved", "add"), sIn = rect("saved", "input"), sNew = rect("saved", "newCard");
    add(T.saved + 600, c("saved", CW / 2, sIn.y + sIn.h / 2 + 96, 2.3));
    hold(tAdd + 300, 1.02);
    add(tAdd + 2100, c("saved", clamp(sNew.x + sNew.w / 2, 150, 240), clamp(sNew.y + Math.min(sNew.h, 300) / 2, 150, 694), camFit({ w: sNew.w, h: Math.min(sNew.h, 300) }, 1250, 800, 2.3, 3.3)));
    hold(T.music - 600, 1.03);
    // 7: Music. Arrive on the top of the page, follow down to the playlists as the capture scrolls;
    // if a playlist is opened, frame the sheet. With no events (the stand-in still), a slow drift down.
    const mS = evOpt("music", "scrollStart"), mE = evOpt("music", "scrollEnd"), mOpen = evOpt("music", "open");
    const pl = rect("music", "playlists"), sheet = rect("music", "sheet");
    add(T.music + 600, c("music", CW / 2, 250, 2.3));
    if (mS !== null && mE !== null && mE > mS) {
      hold(Math.max(mS, T.music + 700), 1.01);
      add(Math.max(mE, mS + 600), c("music", CW / 2, clamp(pl.y + Math.min(pl.h, 330) / 2, 200, 644), 2.45), inOutSoft);
    } else {
      hold(T.music + 900, 1.005);
      add(mOpen !== null ? mOpen - 200 : T.habits - 600, c("music", CW / 2, clamp(pl.y + 40, 250, 520), 2.45), inOutSoft);
    }
    if (mOpen !== null) {
      hold(mOpen + 100, 1.01);
      add(mOpen + 1400, c("music", CW / 2, clamp(sheet.y + Math.min(sheet.h, 440) / 2, 200, 644), camFit({ w: sheet.w, h: Math.min(sheet.h, 440) }, 1500, 940, 1.9, 2.6)));
    }
    hold(T.habits - 600, 1.03);
    // 8: Habits, then Health beside it, ending on the Sleep card.
    const tick = rect("habits", "tick"), sleep = rect("health", "sleepCard");
    add(T.habits + 600, c("habits", CW / 2, tick.y + tick.h / 2 + 70, 2.5));
    hold(T.health, 1.03);
    add(T.health + 1200, c("health", CW / 2, clamp(sleep.y + 190, 220, 624), 2.2));
    add(T.pullStart, c("health", CW / 2, clamp(sleep.y + Math.min(sleep.h, 380) / 2, 200, 644), 2.55), inOutSoft);
    // 9: all the way back until the whole wall fills the frame (89% of the binding side, drifting in to ~92%).
    const zWall = 0.89 * Math.min(H / WALL.h, W / WALL.w);
    add(T.pullEnd, { x: WALL.cx, y: WALL.cy, z: zWall }, inOutStrong);
    hold(T.fall, 1.03);
    hold(T.end, 1.03);
    for (let i = 1; i < k.length; i++) if (k[i].t <= k[i - 1].t) k[i].t = k[i - 1].t + 1;
    CAM = k;
  }
  function cameraAt(t) {
    let i = 0;
    while (i < CAM.length - 2 && t >= CAM[i + 1].t) i++;
    const a = CAM[i], b = CAM[i + 1];
    const p = b.ease(prog(t, a.t, b.t));
    const z = Math.exp(lerp(Math.log(a.z), Math.log(b.z), p));
    // Zoom-compensated blend, so a point on the wall travels in a straight line on screen while zooming.
    const u = Math.abs(a.z - b.z) < 1e-6 ? p : (1 / z - 1 / a.z) / (1 / b.z - 1 / a.z);
    // Always very slightly moving.
    const sx = 5 * Math.sin(t / 3100), sy = 4 * Math.cos(t / 2700);
    return { x: lerp(a.x, b.x, u) + sx / z, y: lerp(a.y, b.y, u) + sy / z, z };
  }
  const project = (cam, wx, wy) => [W / 2 + (wx - cam.x) * cam.z, H / 2 + (wy - cam.y) * cam.z];

  // ---------- scene 2 tiles ----------
  const TILE = { size: 150, pitch: 186, y: 612, icon: 66, radius: 35 };
  const ICON = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  // app/src/components/icons.ts, in the Library's order: Notes, Saved, People, Places, Trips, Money, Music, Health.
  const ICONS = [
    `<rect x="5" y="3.5" width="14" height="17" rx="3"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/>`,
    `<path d="M6.5 5.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v15l-5.5-3.8-5.5 3.8z"/>`,
    `<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c.8-3.4 3.4-5 7-5s6.2 1.6 7 5"/>`,
    `<path d="M12 20.5s6.5-5.6 6.5-10.8a6.5 6.5 0 0 0-13 0c0 5.2 6.5 10.8 6.5 10.8z"/><circle cx="12" cy="9.7" r="2.3"/>`,
    `<rect x="4" y="7.5" width="16" height="12" rx="2.8"/><path d="M9 7.5V5.8A1.8 1.8 0 0 1 10.8 4h2.4A1.8 1.8 0 0 1 15 5.8v1.7M8.5 7.5v12M15.5 7.5v12"/>`,
    `<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H17v2.5"/><rect x="4" y="8.5" width="16" height="11" rx="3"/><circle cx="16" cy="14" r="1.1" fill="currentColor" stroke="none"/>`,
    `<path d="M9 17.5V6l10-2v11.5"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>`,
    `<path d="M12 19.5s-7-4.2-7-9.3A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.2c0 5.1-7 9.3-7 9.3z"/>`,
  ];
  const tileT = (i) => T.tile0 + i * BEAT;
  const tileCount = (t) => { let n = 0; for (let i = 0; i < 8; i++) n += outExpo(prog(t, tileT(i), tileT(i) + 520)); return Math.max(1, n); };
  const tileX = (i, n) => W / 2 + (i - (n - 1) / 2) * TILE.pitch;
  const slotX = (i) => tileX(i, Math.max(1, i)); // where tile i pops, before the row re-centres
  const ORB1 = { x: W / 2, y: 340 };

  // ---------- the lines ----------
  const LINE1 = ["Everything", "you'd", "otherwise", "forget"], LINE1_Y = 806;
  const PRE = "Athena remembers the ";
  // The swap schedule is data: swaps.json beside this file, [{at, phrase, how}]. At `at` ms the phrase after
  // "Athena remembers the " becomes `phrase`. how: "type" = typed on, complete by `at`; "retype" = the pointer
  // drags a selection from `at` and it is retyped within 350ms; "swap" = replaced in place at `at`;
  // "final" = the last phrase, also in place. Loaded at boot (render.cjs injects it; otherwise fetched).
  let SWAPS = [];
  async function loadSwaps() {
    let data = CFG.swaps;
    if (!data) {
      try { data = await (await fetch("swaps.json")).json(); } catch (e) {
        data = await new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open("GET", "swaps.json"); x.onload = () => { try { res(JSON.parse(x.responseText)); } catch (err) { rej(err); } }; x.onerror = () => rej(new Error("swaps.json could not be loaded")); x.send(); });
      }
    }
    SWAPS = data.slice().sort((a, b) => a.at - b.at);
    // Each in-place swap settles over 80ms, or less when the next one is close, so every phrase rests for at least a frame.
    SWAPS.forEach((x, i) => { const next = SWAPS[i + 1]; x.settle = next ? clamp(next.at - x.at - 1000 / FPS - 1, 20, 80) : 80; });
    const fin = SWAPS.find((x) => x.how === "final") || SWAPS[SWAPS.length - 1];
    T.lift = fin.at; T.lifted = fin.at + 600;
    window.FILM_SWAPS = SWAPS.map((x) => ({ at: x.at, phrase: x.phrase, how: x.how }));
  }
  const L2 = { y: H / 2, liftY: 286, liftScale: 0.8, drag: 150, dragLead: 40, reAt: 170, reEnd: 340 };
  const LOCK = { orb: 172, gap: 40 };
  let meas = null; // text widths, measured once the fonts are in
  function measure() {
    const s = document.createElement("span");
    s.className = "line line--close"; s.style.visibility = "hidden";
    $("content").appendChild(s);
    const w = (txt) => { s.textContent = txt; return s.getBoundingClientRect().width; };
    const m = { pre: w(PRE), ph: {} };
    for (const x of SWAPS) m.ph[x.phrase] = w(PRE + x.phrase) - m.pre;
    s.remove();
    // Left-aligned from a fixed x, chosen so the line with the longest phrase is centred: the fixed part never shifts.
    m.left = W / 2 - (m.pre + Math.max(...Object.values(m.ph))) / 2;
    m.word = $("wordmark").getBoundingClientRect().width;
    meas = m;
  }
  // -> { pre, sel, rest, caret, settle } ; settle = ms since an in-place swap (for its small vertical settle)
  function line2State(t) {
    // Swap times in the data are whole ms; frame times are multiples of 1000/30. Half a ms of tolerance
    // puts every swap on the frame it names (60067 on frame 1802), so each one gets the same settle.
    t += 0.5;
    if (t < T.line2 + 20) return null;
    const first = PRE + SWAPS[0].phrase;
    if (t < SWAPS[0].at) {
      const n = clamp(Math.ceil(((t - T.line2) / (SWAPS[0].at - 30 - T.line2)) * first.length), 0, first.length);
      return { pre: first.slice(0, Math.min(n, PRE.length)), sel: "", rest: first.slice(PRE.length, n), caret: true, typing: true, settle: 1e9 };
    }
    let i = 0;
    while (i < SWAPS.length - 1 && t >= SWAPS[i + 1].at - (SWAPS[i + 1].how === "retype" ? L2.dragLead : 0)) i++;
    const cur = SWAPS[i];
    if (cur.how === "retype") {
      const prev = SWAPS[i - 1].phrase;
      if (t < cur.at + L2.reAt) {
        // The pointer drags the selection across the old phrase.
        const n = Math.round(inOut(prog(t, cur.at - L2.dragLead, cur.at + L2.drag)) * prev.length);
        return { pre: PRE, sel: prev.slice(0, n), rest: prev.slice(n), caret: false, settle: 1e9 };
      }
      const n = clamp(Math.ceil(((t - cur.at - L2.reAt) / (L2.reEnd - L2.reAt)) * cur.phrase.length), 1, cur.phrase.length);
      return { pre: PRE, sel: "", rest: cur.phrase.slice(0, n), caret: !SWAPS[i + 1] || SWAPS[i + 1].how === "retype" || t < SWAPS[i + 1].at - 150, typing: t < cur.at + L2.reEnd + 150, settle: 1e9, settleDur: 80 };
    }
    const inPlace = cur.how === "swap" || cur.how === "final";
    return { pre: PRE, sel: "", rest: cur.phrase, caret: cur.how === "type", settle: inPlace ? t - cur.at : 1e9, settleDur: cur.settle || 80 };
  }

  // ---------- the check-in card (scene 11) ----------
  // The `checkin` capture cropped to its card, large, beneath the lifted line. Until the capture
  // exists this is a crop of the Days stand-in still.
  let CK = null;
  function buildCheckin() {
    const real = !!(M.checkin && M.checkin.frames);
    const card = rect("checkin", "card"), great = rect("checkin", "great");
    const mood = M.checkin && M.checkin.rects && M.checkin.rects.moodBlock;
    // The real card is the whole tall evening card: show it from its top down to just under the five moods,
    // full card width, rounded as its own card. Without that rect (the stand-in still), the card rect plus a little padding.
    const pad = mood ? 0 : 12;
    const x0 = Math.max(0, card.x - pad), y0 = Math.max(0, card.y - pad);
    const x1 = Math.min(CW, card.x + card.w + pad), y1 = mood ? Math.min(CH, mood.y + mood.h + 14) : Math.min(CH, card.y + card.h + pad);
    const w = x1 - x0, h = y1 - y0;
    // About 1180px wide. A short card sits centred beneath the line; a card too tall for that
    // (the real check-in card is the whole evening card) lands with its top under the line and runs off the bottom of the frame.
    const scale = 1180 / w, top = 384, room = H - top - 70;
    const cy = h * scale <= room ? top + room / 2 : top + 6 + (h * scale) / 2;
    CK = { real, x0, y0, w, h, scale, cx: W / 2, cy, start: T.great - capEv("checkin", "press"),
      great: [W / 2 + (great.x + great.w / 2 - x0 - w / 2) * scale, cy + (great.y + great.h / 2 - y0 - h / 2) * scale] };
    const el = $("checkin");
    el.style.width = w + "px"; el.style.height = h + "px";
    el.style.borderRadius = Math.min(24, h * 0.22).toFixed(1) + "px";
    CK.layer = { img: el.firstElementChild, src: null };
    CK.layer.img.style.left = -x0 + "px"; CK.layer.img.style.top = -y0 + "px";
  }
  function checkinSources(t) {
    const look = `${CFG.look}/days.png`;
    if (!CK.real) return [look];
    const n = M.checkin.frames;
    const i = clamp(Math.floor(((t - CK.start) * FPS) / 1000 + 1e-6), 0, n - 1);
    return [`${CFG.cap}/checkin/${pad4(i)}.jpg`, look];
  }

  // ---------- pointer ----------
  let PTR = [], PRESS = [];
  function buildPointer() {
    const st = (x, y) => () => [x, y];
    const cd = (name, x, y) => (t) => project(cameraAt(t), CARDS[name].x + x, CARDS[name].y + y);
    const wd = (x, y) => (t) => project(cameraAt(t), x, y);
    const k = [], pr = [];
    const at = (t, pos, bend = 1) => k.push({ t, pos, bend });
    const press = (t, hold = 0) => pr.push({ t, hold });

    // 1: wanders in from lower right, pauses centre, presses: the orb.
    at(0, st(1650, 1190)); at(960, st(ORB1.x + 24, ORB1.y + 34)); press(T.orbPop);
    at(T.orbPop + 100, st(ORB1.x + 24, ORB1.y + 34)); at(1900, st(ORB1.x + 96, ORB1.y + 104), 0.5); at(T.orbPress - 20, st(ORB1.x + 20, ORB1.y + 28), 0.5); press(T.orbPress);
    // 2: taps each tile into being.
    for (let i = 0; i < 8; i++) { at(tileT(i) - 20, st(slotX(i) + 12, TILE.y + 36), i ? 0.6 : 1); press(tileT(i)); at(tileT(i) + 140, st(slotX(i) + 12, TILE.y + 36)); }
    at(8100, st(1500, 930)); at(8950, st(1484, 922), 0);
    // 3: presses the first tile and rides the dive.
    at(T.dive - 20, st(tileX(0, 8) + 12, TILE.y + 30)); press(T.dive);
    at(T.dive + 120, st(tileX(0, 8) + 12, TILE.y + 30));
    at(T.diveEnd, st(1566, 640)); at(12500, st(1570, 660), 0);
    // 4: glides down with the camera to rest beside the late chip.
    const chip = rect("home", "lateChip"), cy = chip.y + chip.h / 2;
    at(14800, cd("home", chip.x + chip.w + 34, cy + 10)); at(T.ask - 600, cd("home", chip.x + chip.w + 34, cy + 10), 0);
    // 5: Ask. Press the field as typing starts, press send, step aside for the answer.
    const tType = ev("ask", "typeStart"), tSend = ev("ask", "send"), tAns = ev("ask", "answer"), tDone = ev("ask", "answerDone");
    const input = rect("ask", "input"), ans = rect("ask", "answer");
    let send = rect("ask", "send");
    // The send arrow sits at the right end of the field's row; if the manifest's rect is somewhere else, estimate it from the field.
    if (!send || Math.abs(send.y + send.h / 2 - (input.y + input.h / 2)) > 40) send = { x: input.x + input.w + 60, y: input.y, w: 44, h: 44 };
    const inP = [input.x + Math.min(96, input.w * 0.4), input.y + input.h / 2 + 2];
    at(tType - 90, cd("ask", inP[0], inP[1])); press(tType - 60);
    at(tType + 200, cd("ask", inP[0], inP[1]), 0); at(tType + 900, cd("ask", inP[0] + 44, inP[1] + 56), 0.5); at(tSend - 650, cd("ask", inP[0] + 44, inP[1] + 56), 0);
    at(tSend - 70, cd("ask", ...mid(send)), 0.6); press(tSend - 40);
    at(tSend + 150, cd("ask", ...mid(send)), 0);
    at(tSend + 1500, cd("ask", 428, clamp(ans.y + 110, 200, 700))); at(tAns + 200, cd("ask", 428, clamp(ans.y + 110, 200, 700)), 0);
    at(tAns + 1300, cd("ask", ans.x + ans.w + 30, ans.y + 120), 0.5); at(tAns + 1700, cd("ask", ans.x + ans.w + 30, ans.y + 120), 0);
    at(tDone + 100, cd("ask", 424, ans.y + ans.h * 0.74), 0.5); at(T.saved - 600, cd("ask", 424, ans.y + ans.h * 0.74), 0);
    // 6: Saved. Press the field as the thing arrives in it, press again as it is kept, rest beside the new card.
    const tS = evOpt("saved", "paste") ?? ev("saved", "typeStart"), tAdd = ev("saved", "add"), sIn = rect("saved", "input"), sNew = rect("saved", "newCard");
    const sP = [sIn.x + Math.min(120, sIn.w * 0.4), sIn.y + sIn.h / 2 + 2];
    at(tS - 90, cd("saved", sP[0], sP[1])); press(tS - 60);
    at(tS + 200, cd("saved", sP[0], sP[1]), 0);
    if (tAdd - tS > 1700) { at(tS + 900, cd("saved", 414, sP[1] + 44), 0.5); at(tAdd - 650, cd("saved", 414, sP[1] + 44), 0); }
    at(tAdd - 70, cd("saved", sIn.x + sIn.w - 22, sIn.y + sIn.h / 2), 0.6); press(tAdd - 40);
    at(tAdd + 150, cd("saved", sIn.x + sIn.w - 22, sIn.y + sIn.h / 2), 0);
    const sRest = [Math.min(sNew.x + sNew.w + 26, 420), sNew.y + Math.min(sNew.h, 300) * 0.62];
    at(tAdd + 1700, cd("saved", sRest[0], sRest[1])); at(T.music - 600, cd("saved", sRest[0], sRest[1]), 0);
    // 7: Music. Rests beside the page; opens the playlist if the capture does.
    const mOpen = evOpt("music", "open"), mE = evOpt("music", "scrollEnd"), tile = rect("music", "tile"), sheet = rect("music", "sheet"), pl = rect("music", "playlists");
    at(T.music + 700, cd("music", 424, 300));
    if (mOpen !== null) {
      at(mOpen - 700, cd("music", 424, clamp(pl.y + 60, 200, 700)), 0.4);
      at(mOpen - 70, cd("music", ...mid(tile)), 0.6); press(mOpen - 40);
      at(mOpen + 200, cd("music", ...mid(tile)), 0);
      at(mOpen + 1400, cd("music", 424, clamp(sheet.y + 200, 200, 700)), 0.5); at(T.habits - 600, cd("music", 424, clamp(sheet.y + 200, 200, 700)), 0);
    } else {
      at(T.habits - 600, cd("music", 424, clamp(pl.y + 80, 300, 600)), 0.3);
    }
    // 8: Habits: tick today's habit. Then on to Health.
    const tTick = ev("habits", "tick"), tick = rect("habits", "tick"), sleep = rect("health", "sleepCard");
    at(tTick - 70, cd("habits", ...mid(tick))); press(tTick - 40);
    at(tTick + 200, cd("habits", ...mid(tick)), 0); at(tTick + 1000, cd("habits", tick.x + tick.w + 66, tick.y + tick.h + 34), 0.5); at(T.health, cd("habits", tick.x + tick.w + 66, tick.y + tick.h + 34), 0);
    at(T.health + 1300, cd("health", 424, clamp(sleep.y + 150, 200, 700))); at(T.pullStart, cd("health", 424, clamp(sleep.y + 230, 200, 700)), 0);
    // 9: small among the cards.
    at(T.pullEnd, wd(WALL.cx + 295, WALL.cy + 6)); at(T.wallFall - 100, wd(WALL.cx + 285, WALL.cy + 14), 0);
    // 10: waits just under the line (clear of the letters), drags a selection across the phrase for each
    // "retype", then steps aside while the swaps quicken.
    const x0 = meas.left + meas.pre, pyWait = L2.y + 98, py = L2.y + 68;
    const re = SWAPS.map((x, i) => i).filter((i) => SWAPS[i].how === "retype");
    at(SWAPS[0].at + 60, st(x0 - 10, pyWait), 0.6);
    re.forEach((i, j) => {
      const sw = SWAPS[i], wPrev = meas.ph[SWAPS[i - 1].phrase];
      at(sw.at - 160, st(x0 - 8, pyWait), 0);
      at(sw.at - L2.dragLead, st(x0 - 3, py), 0.3); press(sw.at - 20, L2.drag);
      at(sw.at + L2.drag, st(x0 + wPrev + 3, py), 0);
      at(sw.at + L2.drag + 60, st(x0 + wPrev + 3, py), 0);
      if (j < re.length - 1) at(sw.at + 420, st(x0 - 8, pyWait), 0.3);
    });
    const tAside = (re.length ? SWAPS[re[re.length - 1]].at : SWAPS[0].at) + 750;
    at(tAside, st(1560, 790), 0.6); at(T.lifted - 150, st(1572, 800), 0);
    // 11: onto "Great", pressed on the final chord.
    at(T.great - 50, st(CK.great[0] + 4, CK.great[1] + 18), 0.5); press(T.great);
    at(T.great + 260, st(CK.great[0] + 4, CK.great[1] + 18), 0);
    at(T.great + 900, st(Math.min(CK.great[0] + 150, 1700), Math.min(CK.great[1] + 120, 960)), 0.5); at(T.lockup, st(Math.min(CK.great[0] + 154, 1704), Math.min(CK.great[1] + 124, 964)), 0);
    // 12: leaves.
    at(T.lockup + 800, st(1760, 1190), 0.6);
    at(T.end + 1, st(1760, 1190), 0);
    for (let i = 1; i < k.length; i++) if (k[i].t <= k[i - 1].t) k[i].t = k[i - 1].t + 1;
    PTR = k; PRESS = pr;
  }
  function pointerAt(t) {
    let i = 0;
    while (i < PTR.length - 2 && t >= PTR[i + 1].t) i++;
    const a = PTR[i], b = PTR[i + 1];
    const p = inOut(prog(t, a.t, b.t));
    const A = a.pos(t), B = b.pos(t);
    const dx = B[0] - A[0], dy = B[1] - A[1];
    // A shallow arc: bow sideways, most at the middle of the move.
    const bow = 0.13 * b.bend * Math.sin(Math.PI * p) * (dx >= 0 ? 1 : -1);
    let x = lerp(A[0], B[0], p) - dy * bow, y = lerp(A[1], B[1], p) + dx * bow;
    // Never quite still.
    x += 2.2 * Math.sin(t / 830); y += 2.2 * Math.cos(t / 1010);
    let down = 0, ripple = null;
    for (const pr of PRESS) {
      const e = t < pr.t ? prog(t, pr.t - 110, pr.t) : 1 - prog(t, pr.t + pr.hold, pr.t + pr.hold + 240);
      down = Math.max(down, inOutSoft(e));
      if (t >= pr.t && t < pr.t + 520) ripple = (t - pr.t) / 520;
    }
    const small = lerp(1, 0.72, inOut(prog(t, T.pullStart, T.pullEnd)) * (1 - inOut(prog(t, T.wallFall, T.wallFall + 700))));
    return { x, y, scale: small * (1 - 0.2 * down), base: small, ripple };
  }

  // ---------- DOM ----------
  const cardEls = {};
  function build() {
    const world = $("world");
    for (const n of Object.keys(CARDS)) {
      const el = document.createElement("div"); el.className = "card";
      const mk = () => { const i = document.createElement("img"); i.alt = ""; i.decoding = "sync"; el.appendChild(i); return { img: i, src: null }; };
      const A = mk(), B = mk();
      let cover = null;
      if (n === "home") {
        cover = document.createElement("div"); cover.className = "card__cover";
        cover.innerHTML = ICON(ICONS[0]);
        el.appendChild(cover);
      }
      world.appendChild(el);
      cardEls[n] = { el, A, B, cover };
    }
    const tiles = $("tiles");
    ICONS.forEach((ic) => { const d = document.createElement("div"); d.className = "tile"; d.innerHTML = ICON(ic); tiles.appendChild(d); });
    $("line1").innerHTML = LINE1.map((w, i) => `<span class="w">${w}${i < LINE1.length - 1 ? " " : ""}</span>`).join("");
  }

  // ---------- screen images ----------
  const bad = new Set();
  const pad4 = (n) => String(n).padStart(4, "0");
  // -> { a: [urls to try], b: [urls] | null, mix: opacity of b over a }
  // A shot may name capture frames to hide in the manifest: <shot>.cover = { from, to } (frame indices, inclusive).
  // Those frames show a cross-blend from frame from-1 to frame to+1 instead (the app re-rendering a list, say).
  function sources(name, t) {
    const look = `${CFG.look}/${LOOK[name] || name}.png`;
    const c = CARDS[name];
    const m = c.shot ? M[name] : null;
    // A still, or a shot whose capture has not landed: the captured still if there is one, else the stand-in.
    if (!m || !m.frames) return { a: [`${CFG.cap}/stills/${name}.jpg`, look], b: null, mix: 0 };
    const n = m.frames;
    let local = t - SHOT_START[name];
    if (name === "ask") local = askCapTime(Math.max(0, local));
    let i = Math.floor((local * FPS) / 1000 + 1e-6);
    if (name === "graph" && n > 1) {
      // Ping-pong, so the nodes keep moving however long the pull-back lasts.
      const span = 2 * (n - 1); i = ((Math.max(0, i) % span) + span) % span; if (i > n - 1) i = span - i;
    }
    i = clamp(i, 0, n - 1);
    const url = (k) => [`${CFG.cap}/${name}/${pad4(k)}.jpg`, look];
    const h = m.cover;
    if (h && typeof h.from === "number" && typeof h.to === "number" && i >= h.from && i <= h.to && h.from > 0 && h.to < n - 1) {
      return { a: url(h.from - 1), b: url(h.to + 1), mix: inOutSoft((i - h.from + 1) / (h.to - h.from + 2)) };
    }
    return { a: url(i), b: null, mix: 0 };
  }
  async function setImage(layer, cands) {
    for (const u of cands) {
      if (bad.has(u)) continue;
      if (layer.src === u) return;
      try { layer.img.src = u; await layer.img.decode(); layer.src = u; return; } catch (e) { bad.add(u); layer.src = null; }
    }
  }

  // ---------- draw ----------
  const tf = (el, s) => { el.style.transform = s; };
  const show = (el, o) => { el.style.opacity = o <= 0.001 ? "0" : o >= 0.999 ? "1" : o.toFixed(4); el.style.visibility = o <= 0.001 ? "hidden" : "visible"; };

  function draw(t) {
    const jobs = [];
    const cam = cameraAt(t);

    // Aurora: a slow drift, as in base.css.
    const da = Math.sin(t / 8200), db = Math.sin(t / 10100 + 1.3);
    tf($("aurA"), `translate(${(150 * da).toFixed(2)}px, ${(70 * da).toFixed(2)}px) scale(${(1.06 + 0.06 * da).toFixed(4)})`);
    tf($("aurB"), `translate(${(-170 * db).toFixed(2)}px, ${(50 * db).toFixed(2)}px) scale(${(0.98 - 0.05 * db).toFixed(4)})`);

    // Wall.
    const diveQ = inOut(prog(t, T.dive, T.dive + 1250));
    for (const n of Object.keys(CARDS)) {
      const c = CARDS[n], d = cardEls[n];
      let o = n === "home" ? (t >= T.dive ? 1 : 0) : prog(t, T.diveEnd, T.diveEnd + 300);
      // 9: the wall falls away, column by column.
      const f0 = T.wallFall + c.col * 18 + c.row * 14;
      const fp = prog(t, f0, f0 + 260);
      const fall = inCubic(fp) * 620;
      o *= 1 - inOutSoft(prog(fp, 0.25, 0.95));
      // 3: the Home card starts as tile 1 (a square window with the tile's icon) and opens out.
      let inset = 0, radius = 44;
      if (n === "home" && t < T.home) {
        inset = ((CH - CW) / 2) * (1 - diveQ);
        radius = lerp((TILE.radius * CW) / TILE.size, 44, diveQ);
        const co = 1 - inOutSoft(prog(t, T.dive + 80, T.dive + 800));
        show(d.cover, co);
        d.cover.firstChild.style.width = d.cover.firstChild.style.height = ((TILE.icon * CW) / TILE.size).toFixed(1) + "px";
      } else if (d.cover) show(d.cover, 0);
      const [px, py] = project(cam, c.x, c.y + inset + fall);
      const w = CW * cam.z, h = (CH - 2 * inset) * cam.z;
      const vis = o > 0.001 && px < W + 80 && px + w > -80 && py < H + 80 && py + h > -80;
      show(d.el, vis ? o : 0);
      if (!vis) continue;
      d.el.style.height = (CH - 2 * inset).toFixed(2) + "px";
      d.el.style.borderRadius = radius.toFixed(2) + "px";
      d.A.img.style.top = d.B.img.style.top = (-inset).toFixed(2) + "px";
      tf(d.el, `translate(${px.toFixed(3)}px, ${py.toFixed(3)}px) scale(${cam.z.toFixed(5)})`);
      const src = sources(n, t);
      jobs.push(setImage(d.A, src.a));
      d.B.img.style.opacity = src.b ? src.mix.toFixed(4) : "0";
      if (src.b) jobs.push(setImage(d.B, src.b));
    }

    // 1-3: orb, tiles, line.
    const orbIn = outExpo(prog(t, T.orbPop, T.orbPop + 620));
    const orbOut = inCubic(prog(t, T.dive, T.dive + 320));
    const squeeze = 1 - 0.07 * Math.sin(Math.PI * prog(t, T.orbPress - 60, T.orbPress + 320));
    const breathe = 1 + 0.012 * Math.sin(t / 900);
    const orb1 = $("orb1");
    show(orb1, t >= T.orbPop && orbOut < 1 ? 1 : 0);
    tf(orb1, `translate(${ORB1.x}px, ${ORB1.y + orbOut * 40}px) scale(${(orbIn * (1 - orbOut) * squeeze * breathe).toFixed(4)})`);
    tf(orb1.firstElementChild, `rotate(${((t / 11000) * 360).toFixed(2)}deg)`);

    const n = tileCount(t);
    const tiles = $("tiles").children;
    for (let i = 0; i < 8; i++) {
      const pop = outExpo(prog(t, tileT(i), tileT(i) + 480));
      const fp = prog(t, T.dive + 40 + i * 34, T.dive + 40 + i * 34 + 420);
      const gone = i === 0 ? t >= T.dive : fp >= 1;
      show(tiles[i], t >= tileT(i) && !gone ? 1 - inOutSoft(prog(fp, 0.4, 1)) : 0);
      const tap = 1 - 0.05 * Math.sin(Math.PI * prog(t, T.dive - 110, T.dive + 60)) * (i === 0 ? 1 : 0);
      tf(tiles[i], `translate(${tileX(i, n).toFixed(2)}px, ${(TILE.y + inCubic(fp) * 420).toFixed(2)}px) rotate(${(inCubic(fp) * (i % 2 ? 7 : -6)).toFixed(2)}deg) scale(${(pop * tap).toFixed(4)})`);
    }

    const l1 = $("line1"), words = l1.children;
    show(l1, t >= T.line1 && t < T.dive + 700 ? 1 : 0);
    tf(l1, `translate(0px, ${LINE1_Y - 44}px)`);
    for (let i = 0; i < words.length; i++) {
      const a = outExpo(prog(t, T.line1 + i * 300, T.line1 + i * 300 + 420));
      const fp = prog(t, T.dive + 60 + i * 40, T.dive + 60 + i * 40 + 380);
      words[i].style.opacity = (a * (1 - inOutSoft(prog(fp, 0.3, 1)))).toFixed(4);
      tf(words[i], `translate(0px, ${((1 - a) * 22 + inCubic(fp) * 300).toFixed(2)}px)`);
    }

    // 10-11: the closing line, its swaps, and the lift.
    const s = line2State(t), l2 = $("line2");
    const out = prog(t, T.lockup, T.lockup + 240);
    const lift = inOut(prog(t, T.lift, T.lifted));
    const lockLeft = W / 2 - (LOCK.orb + LOCK.gap + meas.word) / 2;
    show(l2, s && out < 1 ? 1 - inOutSoft(out) : 0);
    if (s) {
      const key = s.pre + "|" + s.sel + "|" + s.rest;
      if (l2._k !== key) { $("l2a").textContent = s.pre; $("l2sel").textContent = s.sel; $("l2b").textContent = s.rest; l2._k = key; }
      // An in-place swap arrives from a little below, quickly: a flicker, not a glitch.
      const st = outExpo(clamp(s.settle / (s.settleDur || 80)));
      tf($("l2b"), `translate(0px, ${((1 - st) * 10).toFixed(2)}px)`);
      $("l2b").style.opacity = lerp(0.35, 1, st).toFixed(3);
      // Lifted, the line is centred on its final phrase at 80%.
      const sc = lerp(1, L2.liftScale, lift) * lerp(1, 0.3, inCubic(out));
      const liftLeft = W / 2 - (L2.liftScale * (meas.pre + meas.ph[SWAPS[SWAPS.length - 1].phrase])) / 2;
      const x = lerp(lerp(meas.left, liftLeft, lift), lockLeft + LOCK.orb, inCubic(out));
      const y = lerp(lerp(L2.y, L2.liftY, lift), H / 2, inCubic(out));
      l2.style.transformOrigin = "0 50%";
      tf(l2, `translate(${x.toFixed(2)}px, ${(y - 50).toFixed(2)}px) scale(${sc.toFixed(4)})`);
      $("caret").style.opacity = s.caret && (s.typing || Math.floor((t / BEAT) * 2) % 2 === 0) ? "1" : "0";
    }

    // 11: the check-in card rises in beneath the line.
    const ck = $("checkin");
    const rise = 1 - Math.pow(1 - prog(t, T.lift + 40, T.lifted), 4);
    show(ck, t >= T.lift + 40 && out < 1 ? 1 - inOutSoft(out) : 0);
    if (t >= T.lift + 40 && out < 1) {
      const kick = 1 - 0.012 * Math.sin(Math.PI * prog(t, T.great - 60, T.great + 300));
      const sc = CK.scale * kick;
      const topY = CK.cy - (CK.h * CK.scale) / 2;
      // Scales about the pressed control, so the press reads as a small give under the pointer.
      const y = topY + (1 - rise) * (H - topY + 40) + inCubic(out) * 90 - (CK.great[1] - topY) * (kick - 1);
      tf(ck, `translate(${(CK.cx - (CK.w * sc) / 2).toFixed(2)}px, ${y.toFixed(2)}px) scale(${sc.toFixed(5)})`);
      jobs.push(setImage(CK.layer, checkinSources(t)));
    }

    // 12: orb and wordmark, as a centred pair.
    const lk = $("lockup"), orb2 = $("orb2"), wm = $("wordmark");
    show(lk, t >= T.lockup ? 1 : 0);
    if (t >= T.lockup) {
      const oi = outExpo(prog(t, T.lockup + 150, T.lockup + 480));
      tf(orb2, `translate(${(lockLeft + LOCK.orb / 2).toFixed(2)}px, ${H / 2}px) scale(${(oi * (1 + 0.012 * Math.sin(t / 900))).toFixed(4)})`);
      tf(orb2.firstElementChild, `rotate(${((t / 11000) * 360).toFixed(2)}deg)`);
      const wi = outExpo(prog(t, T.lockup + 220, T.lockup + 480));
      wm.style.opacity = wi.toFixed(4);
      tf(wm, `translate(${(lockLeft + LOCK.orb + LOCK.gap + (1 - wi) * -26).toFixed(2)}px, ${H / 2 - 95 - 7}px)`);
    }

    // Fade to bare canvas.
    $("content").style.opacity = (1 - inOutSoft(prog(t, T.fade, T.end - 40))).toFixed(4);

    // Pointer.
    const p = pointerAt(t);
    tf($("pointer"), `translate(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px) scale(${p.scale.toFixed(4)})`);
    const rp = $("ripple");
    if (p.ripple === null) show(rp, 0);
    else {
      show(rp, 0.85 * (1 - inOutSoft(p.ripple)));
      tf(rp, `translate(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px) scale(${(p.base * lerp(0.9, 2.5, outExpo(p.ripple))).toFixed(4)})`);
    }
    return jobs;
  }

  // ---------- boot ----------
  const ready = (async () => {
    if (CFG.manifest) M = CFG.manifest;
    else { try { M = await (await fetch(CFG.cap + "/manifest.json")).json(); } catch (e) { M = {}; } }
    await loadSwaps();
    build();
    await Promise.all([document.fonts.load('500 60px "Funnel Display"'), document.fonts.load('600 136px "Funnel Display"'), document.fonts.load('500 20px "Geist"')]);
    await document.fonts.ready;
    measure();
    buildCheckin();
    buildCamera();
    buildPointer();
  })();

  window.seek = async (ms) => {
    await ready;
    await Promise.all(draw(ms));
  };
  // For checks: fonts actually loaded, the camera and pointer at a time, which image each card shows.
  window.filmInfo = async (ms) => {
    await ready;
    return {
      fonts: { funnel: document.fonts.check('500 60px "Funnel Display"'), geist: document.fonts.check('500 20px "Geist"'), faces: [...document.fonts].map((f) => f.family + " " + f.status) },
      cam: cameraAt(ms), ptr: pointerAt(ms), manifest: Object.keys(M), checkin: CK && { real: CK.real, src: CK.layer.src && CK.layer.src.split("/").slice(-2).join("/"), scale: CK.scale, start: CK.start },
      cards: Object.fromEntries(Object.keys(cardEls).map((n) => [n, cardEls[n].A.src && cardEls[n].A.src.split("/").slice(-2).join("/")])),
      camKeys: CAM.map((k) => [k.t, +k.x.toFixed(1), +k.y.toFixed(1), +k.z.toFixed(3)]),
    };
  };
  window.seek(Number(q.get("t") || 0));
})();

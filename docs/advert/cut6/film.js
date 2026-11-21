/* Athena launch film, cut 6: "Athena remembers the good days".
 *
 * One continuous take. Everything on the 1920x1080 stage is computed from `ms`:
 *   window.seek(ms) -> Promise that resolves once that frame is fully drawn.
 * The world is a wall of screen cards in world units (1 unit = 1 CSS px of the 390-wide app).
 *
 * Camera: a sum of eased moves. Each move carries the camera from the previous move's pose to its own,
 * with a lopsided velocity profile (smooth ramp up over `a` ms, longer ramp down over `b` ms). Moves may
 * overlap, so speed carries from one into the next and the camera never stops dead; "holds" are slow
 * drifts. window.camSpeed(ms) gives the fastest on-screen travel (px/frame) for render.cjs's motion blur.
 *
 * Pointer: keys in screen space or pinned to a point on a card. On a lead key the pointer leaves from where
 * it was when it set off (it is not dragged by the world) and homes in on its live target.
 *
 * Captures play through a per-shot time map (anchors: film-local ms -> capture ms), so the app's own
 * events land on the film's beats. Morphs: "grow" (a tapped thing opens into the next view, the next
 * frame revealed through a growing rounded clip) and "fly" (a crop of one frame travels to where the same
 * thing sits in a later frame: Saved poster -> Watch & read cover).
 */
(() => {
  "use strict";

  const W = 1920, H = 1080, FPS = 30, FRAME = 1000 / FPS;
  const FILM = "/tmp/claude-0/-home-user-athena/92254b34-7623-59d6-a458-adb54d88ca12/scratchpad/film6";
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
  const outExpo = (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));
  const outCubic = (p) => 1 - Math.pow(1 - p, 3);
  const inCubic = (p) => p * p * p;
  const $ = (id) => document.getElementById(id);
  // Lopsided move: velocity rises along a smoothstep for `a` ms, falls along one for `b` ms. -> 0..1
  // The peak (fastest moment) is at s + a. The position curve is C2-smooth everywhere.
  function lop(t, s, a, b) {
    const u = t - s;
    if (u <= 0) return 0;
    if (u >= a + b) return 1;
    const v = 2 / (a + b);
    if (u < a) { const x = u / a; return v * a * (x * x * x - (x * x * x * x) / 2); }
    const y = 1 - (u - a) / b;
    return (v * a) / 2 + v * b * (0.5 - (y * y * y - (y * y * y * y) / 2));
  }
  // Fast-early variant: the same smooth ramp up over `a`, then the speed decays exponentially (rate k) over `b`,
  // so most of the distance is covered just after the peak and a long tail settles it.
  function lopX(t, s, a, b, k) {
    const u = t - s;
    if (u <= 0) return 0;
    if (u >= a + b) return 1;
    const ek = Math.exp(-k), D = ((1 - ek) / k - ek) / (1 - ek), v = 1 / (a / 2 + b * D);
    if (u < a) { const x = u / a; return v * a * (x * x * x - (x * x * x * x) / 2); }
    const x = (u - a) / b;
    return (v * a) / 2 + (v * b * ((1 - Math.exp(-k * x)) / k - x * ek)) / (1 - ek);
  }
  // The same shape over [0,1] for a given split (in-share of the duration).
  const lopP = (p, inShare = 0.375) => lop(p, 0, inShare, 1 - inShare);

  // ---------- timeline (ms) ----------
  const BEAT = 600;
  const ASK_Q_LAG = 200; // capture ms from send to the first frame with the sent question fully drawn
  const T_SAYS_OUT = 56950, T_TEAM_IN = 57600; // hire: her chat gives way to "... is on your team"; then the Team page
  const T_PENNY_TAP = 43800, T_HABITS_CUT = 43200, T_STEP_DOWN = 48000, T_ARRIVE = 55200;
  // Flows (cut 6): the camera lands on Athena's suggestion on 60000; "Make it a flow" on 61800; the card is carried into
  // the flow and its steps are there on the 62400 downbeat; switched on on 63600; dropout 64200, the wall on 64800.
  const T_FLOWS = 60000, T_FLOW_TAP = 61800, T_FLOW_STEPS = 62400, T_FLOW_ON = 63600;
  const T = {
    orbPop: 1200, orbPress: 2400, tile0: 3000, tileStep: 300, line1: 5400, dive: 7200,
    home: 9600, ask: 14400, saved: 24000, track: 31200, music: 36000, habits: 40800,
    work: 43200, hire: 50400,
    team: 57600, flows: T_FLOWS,
    // (everything from the pull-back on is cut 5's, 4800 ms later)
    pull: 64800, wallFall: 68850, line2: 69500,
    final: 78000, lift: 78250, lifted: 78850, great: 79200, morph: 81000, word: 82200,
    fade: 86100, end: 86400,
  };
  window.FILM_DURATION_MS = T.end;
  const SHOT_START = { home: T.home, ask: T.ask, saved: T.saved, track: T.track, music: T.music, habits: T.habits, work: T.work, workDone: T.work, hire: T.hire, flow: T.flows };

  // ---------- the wall ----------
  const CW = 390, CH = 844, GAP = 200, PITCH_X = CW + GAP, ROW2 = CH + GAP;
  // Twelve screens, six over six. Top row in camera-travel order (all captures); bottom row stills, plus the graph playing.
  // `crew` is the Team grid (Penny, Dot, Wren), still `team`.
  // The camera travels the top row left to right (Home ... Habits), drops to `work` under Habits and steps left to `hire`.
  const TOP = ["home", "ask", "saved", "track", "music", "habits"];
  // (`work` is Home with Penny at work; `workDone` the saved thing's Tracking page when her check comes in.)
  // (cut 6: Flows takes Health's place, left of the Team page: from Team the camera steps left once more to it)
  const BOTTOM = ["days", "watch", "flow", "hire", "workDone", "work"];
  const SHOTS = new Set(["home", "ask", "saved", "track", "music", "habits", "work", "workDone", "hire", "flow"]);
  const STILL = { track: "tracking", hire: "team", work: "home", workDone: "tracking", flow: "flowEditor" };
  // For the wall: cards the camera has long left show a still instead of their last frame (no page twice on the wall).
  const WALL_STILL = { track: "tracking", work: "money" }, T_WALL_STILL = 53000;
  const HIDE_BY_HIRE = new Set(["flow", "workDone"]);
  // And the flow page's neighbours (Watch & read, the Team page) while the camera is on it, back for the wall.
  const HIDE_BY_FLOW = new Set(["watch", "hire"]);
  const LOOK = { watch: "library", track: "home", work: "home", workDone: "home", hire: "graph", flow: "days" };
  const CARDS = {};
  TOP.forEach((n, i) => (CARDS[n] = { name: n, x: i * PITCH_X, y: 0, col: i, row: 0, shot: SHOTS.has(n) }));
  // The second row sits ABOVE the first: from Habits the camera climbs to `work` and arrives on its chips from below
  // (over the travel card), so Home's greeting, above the chips, never crosses the frame.
  BOTTOM.forEach((n, i) => (CARDS[n] = { name: n, x: i * PITCH_X, y: -ROW2, col: i, row: 1, shot: SHOTS.has(n) }));
  const WALL = { cx: (5 * PITCH_X + CW) / 2, cy: (CH - ROW2) / 2, w: 5 * PITCH_X + CW, h: ROW2 + CH };

  // ---------- manifest, with fallbacks (so the film runs on older captures) ----------
  let M = {};
  const FALLBACK_RECTS = {
    home: { greeting: { x: 16, y: 96, w: 330, h: 124 }, travelCard: { x: 16, y: 241, w: 358, h: 599 }, lateChip: { x: 81, y: 377, w: 187.5, h: 26 }, trainRow: { x: 16, y: 284, w: 358, h: 150 } },
    ask: { input: { x: 63, y: 681, w: 200, h: 44 }, send: { x: 323, y: 681, w: 44, h: 44 }, answer: { x: 71, y: 217, w: 286, h: 423 }, sources: { x: 71, y: 427, w: 286, h: 213 } },
    saved: { input: { x: 16, y: 240, w: 358, h: 44 }, newCard: { x: 16, y: 403, w: 174, h: 117 }, poster: { x: 24, y: 411, w: 60, h: 90 },
      detailPoster: { x: 120, y: 130, w: 150, h: 225 }, moveBtn: { x: 16, y: 690, w: 358, h: 48 }, filed: { x: 16, y: 600, w: 358, h: 40 }, watchCover: { x: 16, y: 230, w: 112, h: 168 } },
    team: { pennyCard: { x: 16, y: 300, w: 358, h: 170 }, avatar: { x: 32, y: 316, w: 44, h: 44 }, line: { x: 88, y: 318, w: 270, h: 46 }, openBtn: { x: 32, y: 418, w: 130, h: 38 },
      seed: { x: 16, y: 120, w: 358, h: 130 }, answer: { x: 16, y: 300, w: 358, h: 200 } },
    music: { playlists: { x: 16, y: 430, w: 358, h: 300 }, tile: { x: 16, y: 470, w: 170, h: 170 }, sheet: { x: 0, y: 190, w: 390, h: 654 } },
    habits: { tick: { x: 26, y: 318, w: 46, h: 46 } },
    checkin: { card: { x: 33, y: 462, w: 324, h: 95 }, great: { x: 297, y: 493, w: 60, h: 65 } },
    // (stand-ins for the Flows shot until its manifest has them)
    flow: { sug: { x: 16, y: 200, w: 358, h: 250 }, sugWhy: { x: 76, y: 240, w: 282, h: 80 }, makeBtn: { x: 32, y: 400, w: 130, h: 36 },
      steps: { x: 16, y: 160, w: 358, h: 300 }, switch: { x: 316, y: 110, w: 52, h: 32 } },
  };
  const FALLBACK_EVENTS = {
    ask: { typeStart: 600, send: 3000, answer: 6000, answerDone: 9600 },
    saved: { typeStart: 600, paste: 600, add: 1500, cardLand: 1900, open: 3000, detail: 3400, move: 4400, filed: 4700, goWatch: 5400, landed: 5900 },
    team: { scrollStart: 300, cardVisible: 1200, tap: 3000, opened: 3400, send: 3800, reply: 4200, replyDone: 4900 },
    music: { open: 1800, sheet: 2100 },
    habits: { tick: 1200 }, checkin: { press: 1200 }, home: {}, graph: {}, flow: { make: 1800, opened: 2300, switchTap: 3600, on: 3700 },
  };
  const rect0 = (shot, name) => (M[shot] && M[shot].rects && M[shot].rects[name]) || (FALLBACK_RECTS[shot] || {})[name];
  const union = (rs) => { const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y)); return { x: x0, y: y0, w: Math.max(...rs.map((r) => r.x + r.w)) - x0, h: Math.max(...rs.map((r) => r.y + r.h)) - y0 }; };
  const rect = (shot, name) => {
    // The flow's steps: its step cards (When ..., Then ...) that sit clear of the page's foot, as one block.
    if (shot === "flow" && name === "steps" && !(M.flow && M.flow.rects && M.flow.rects.steps)) {
      const rows = M.flow && M.flow.rects && (M.flow.rects.stepRows || []).filter((r) => r && r.clear !== false);
      if (rows && rows.length) return union(rows);
    }
    return rect0(shot, name);
  };
  const hasEv = (shot, name) => !!(M[shot] && M[shot].events && typeof M[shot].events[name] === "number");
  // Capture-local time of an event (manifest, else fallback; the fallbacks only stand in for older captures).
  const capEv = (shot, name) => {
    const v = M[shot] && M[shot].events && M[shot].events[name];
    if (typeof v === "number") return v;
    const f = FALLBACK_EVENTS[shot] && FALLBACK_EVENTS[shot][name];
    return typeof f === "number" ? f : null;
  };
  const capLen = (shot) => (M[shot] && M[shot].frames ? M[shot].frames * FRAME : 6000);
  const mid = (r) => [r.x + r.w / 2, r.y + r.h / 2];

  // ---------- capture time maps ----------
  // MAP[shot] = [[filmLocal, capLocal, mode], ...] sorted. Between two anchors the capture plays at 1x from the
  // first; if it runs out of film time it skips ahead to the second anchor's frame ("skip": the tail it drops is
  // the idle wait before a tap), if it runs out of capture it holds the frame just before. "stretch" maps the
  // interval linearly instead (used where a scroll or a stream must be squeezed, not cut).
  const MAP = {};
  function capTime(shot, local) {
    const A = MAP[shot];
    if (!A || !A.length) return local;
    if (local <= A[0][0]) return A[0][1] - (A[0][0] - local);
    for (let i = 0; i < A.length - 1; i++) {
      const [fa, ca] = A[i], [fb, cb, mode] = A[i + 1];
      if (local >= fb) continue;
      if (mode === "stretch") return lerp(ca, cb, (local - fa) / (fb - fa));
      // "hold": the first anchor's frame stays until the second's film time, then the capture jumps (a swap timed to a
      // camera move's fastest frame, where the blur hides it).
      if (mode === "hold") return ca;
      return Math.min(ca + (local - fa), cb - FRAME * 0.5);
    }
    const [fl, cl] = A[A.length - 1];
    return cl + (local - fl);
  }
  // Film time at which a capture event is on screen (first film ms whose capture time reaches it).
  function evF(shot, name) { return filmOfCap(shot, capEv(shot, name)); }
  function filmOfCap(shot, c) {
    if (c === null) return null;
    const s = SHOT_START[shot];
    let lo = -2000, hi = 20000;
    if (capTime(shot, hi) < c) return s + hi;
    for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (capTime(shot, m) >= c - 0.5) hi = m; else lo = m; }
    return s + hi;
  }
  function buildMaps() {
    const L = (shot, film) => film - SHOT_START[shot];
    // Ask: typing and send at 1x; the thinking steps squeezed so the first answer words land on the lift at 19200;
    // the answer streams out by 20600 and then holds.
    {
      const send = capEv("ask", "send"), ans = Math.max(capEv("ask", "answer"), send + 1), done = Math.max(capEv("ask", "answerDone"), ans + 1);
      MAP.ask = [[0, 0], [send, send], [L("ask", 19200), ans, "stretch"], [L("ask", 20600), done, "stretch"]];
      // One frame after send, straight to the first frame with the sent question in its place (the app's route change
      // in between is blank); the question itself flies there from the box (see buildMorphs).
      if (rect("ask", "question")) MAP.ask.splice(2, 0, [send + FRAME, send + ASK_Q_LAG]);
    }
    // Saved: paste on 25200, tap the card on 27600, Move to Watch & read on 28800 (each on a beat).
    {
      const pa = capEv("saved", "paste") ?? capEv("saved", "typeStart");
      MAP.saved = [[0, Math.max(0, pa - 1200)], [L("saved", 25200), pa], [L("saved", 27600), capEv("saved", "open")], [L("saved", 28800), capEv("saved", "move")]];
      // The "Watch & read" link in "Filed in Watch & read" is tapped on 29400 (the capture then opens Watch & read and
      // scrolls to the Films row; the film skips that scroll: the poster carries the cut, see buildMorphs).
      if (hasEv("saved", "linkTap")) MAP.saved.push([L("saved", 29400), capEv("saved", "linkTap")]);
    }
    // Team 1, "Tell me when": the item's header is held first; then the taps: "Tell me when" 33000, "At or under"
    // 33400, 28 typed from 33700, "Tell me" 34200 (the pill and the dashed "Your £28" line appear on that frame).
    if (M.track && M.track.frames) {
      const e = (n) => capEv("track", n);
      MAP.track = [[L("track", 33000), e("tellMeWhen")], [L("track", 33400), e("atOrUnder")], [L("track", 33700), e("typeStart")], [L("track", 34200), e("tellMe")]];
    }
    // Team 2: Penny's chip is tapped on 43800 and her working line shows; it plays on (the dot breathing) and never
    // reaches the capture's end state. Her check comes in on the 48000 downbeat: the Tracking panel redraws in one
    // frame, the price line stepping down under the dashed "Your £28".
    if (M.work && M.work.frames) MAP.work = [[L("work", T_PENNY_TAP), capEv("work", "pennyTap")], [L("work", 60000), (capEv("work", "finish") ?? capLen("work")) - FRAME]];
    if (M.workDone && M.workDone.frames) MAP.workDone = [[L("workDone", T_STEP_DOWN), capEv("workDone", "reached")]];
    // Team 3, hire: the job typed from 50700 at the capture's own speed (done by 53100); Continue on 54000; the
    // silhouette thinks at 1x; on the 55200 downbeat the assistant is there in the silhouette's place (the app's own
    // reveal, its cross-fade frames skipped), says hello (55400) and what it will do (55600: "Every Monday at 9:00,
    // I'll tell you what's due this week."), held to 56800. There the film skips the questions: "... is on your team"
    // (its bubble 100 ms later), to 57600; then the Team page at rest, scrolled to the new face.
    if (M.hire && M.hire.frames) {
      const e = (n) => capEv("hire", n), cov = (k) => (M.hire.covers || []).find((h) => h.at === k);
      const after = (k, ev) => (cov(k) ? (cov(k).to + 1) * FRAME + 1 : e(ev) + 8 * FRAME);
      MAP.hire = [[L("hire", 50700), e("typeStart")], [L("hire", 54000), e("submit")],
        [L("hire", T_ARRIVE), after("arrive", "arrive")], [L("hire", 55400), Math.max(e("hello"), after("arrive", "arrive") + 1), "stretch"], [L("hire", 55600), e("says"), "stretch"],
        [L("hire", T_SAYS_OUT), after("add", "joined")], [L("hire", T_TEAM_IN), capLen("hire") - FRAME]];
    }
    // Flows: the suggestion held from the landing; "Make it a flow" on 61800; the flow page is carried in over 600 ms
    // (see buildMorphs) and its steps are there on 62400; the switch pressed on 63600; then it plays on (held at its end).
    if (M.flow && M.flow.frames) {
      const e = (n) => capEv("flow", n), mk = e("make");
      MAP.flow = [[L("flow", T_FLOW_TAP - 1700), Math.max(0, mk - 1700)], [L("flow", T_FLOW_TAP), mk]];
      if (hasEv("flow", "switchTap")) MAP.flow.push([L("flow", T_FLOW_ON), e("switchTap")]);
    }
    // Music: lands on Playlists; "Evening run" tapped on 37800; the sheet's own entrance is replaced by a grow (300 ms).
    {
      const op = capEv("music", "open"), sh = Math.max(capEv("music", "sheet") ?? op + 300, op + FRAME);
      MAP.music = [[0, Math.max(0, op - 1800)], [L("music", 37800), op], [L("music", 38100), sh, "stretch"]];
      // "Open in Spotify" pressed on 39600.
      if (hasEv("music", "spotify")) MAP.music.push([L("music", 39600), capEv("music", "spotify")]);
    }
    // Habits: the tick lands on 42000.
    // Home: the app's own entrance (the Ask bar and the chips fading in, capture 100-400 ms) plays during the dive's
    // settle, not after it; the live update still lands on 11400.
    if (hasEv("home", "liveUpdate")) MAP.home = [[L("home", 8800), 420], [L("home", 11400), capEv("home", "liveUpdate"), "stretch"]];
    // Habits: the tick lands on 41700 and the count turns ("20 in a row" -> "21 in a row") 100 ms later, so the new
    // count holds ~800 ms before the pull-back leaves.
    MAP.habits = [[L("habits", 41700), capEv("habits", "tick")]];
    if (hasEv("habits", "streakUp")) MAP.habits.push([L("habits", 41800), capEv("habits", "streakUp"), "stretch"]);
  }
  // Morphs, in film time.
  let MORPH = {};
  function buildMorphs() {
    // grow: the next view (capB) is revealed through a rounded clip growing from `from` to `to`. With `fromB` (where the
    // same object sits in the next view), the next view starts shifted so that object sits exactly on `from`, and
    // slides home as the clip grows: the tapped card itself carries on into the page it opens.
    const g = (shot, at, dur, from, to, capA, capB, fromB) => ({ kind: "grow", at, dur, from, to, capA, capB, fromB });
    const full = { x: 0, y: 0, w: CW, h: CH };
    MORPH = { ask: [], saved: [], track: [], music: [], work: [], workDone: [], hire: [], flow: [] };
    // Ask: the question leaves the box on send and flies up to its place as the sent bubble, the camera riding it.
    // Until it lands, its place on the page is covered by a patch of the page's own background (no second copy).
    const aq = rect("ask", "question"), ain = rect("ask", "input");
    if (aq && ain) {
      const ts = evF("ask", "send"), sc = capEv("ask", "send");
      // (its curve matches the camera's ask-steps move, so the bubble stays in frame the whole way)
      MORPH.ask.push({ kind: "fly", at: ts, dur: 760, ease: 0.45, from: ain, to: aq, capA: sc - FRAME, capB: sc + ASK_Q_LAG + 2 * FRAME, mixAt: [0.42, 0.58],
        slot: { background: "linear-gradient(180deg, rgba(221,242,246,0.5), rgba(233,245,248,0.5)), linear-gradient(90deg, rgb(222,241,250), rgb(230,246,244))", boxShadow: "0 0 6px 4px rgb(228,244,247)", borderRadius: "18px" } });
    }
    // Saved: the card opens into its page (the page grows out of the card) while its poster flies to the page's poster.
    const so = evF("saved", "open"), sd = capEv("saved", "detail");
    if (so !== null) {
      // The page arrives carried: it starts with its banner where the card's poster is and slides up into place as it
      // grows round the card, and the card's poster grows into the banner riding on it.
      const dur = 640, capA = capEv("saved", "open") - FRAME, capB = sd ?? capEv("saved", "open") + 400;
      const nc = rect("saved", "newCard"), dp = rect("saved", "detailPoster");
      const grow = g("saved", so, dur, nc, full, capA, capB, { x: dp.x - (rect("saved", "poster").x - nc.x), y: dp.y - (rect("saved", "poster").y - nc.y), w: nc.w, h: nc.h });
      // The card beside it (Lapvona) fades out over the first 120 ms (a patch of the list's background over it).
      grow.patch = { rect: { x: nc.x + nc.w + 7, y: nc.y - 3, w: CW - (nc.x + nc.w + 7) - 12, h: nc.h + 10 }, color: "rgb(245, 246, 250)", ms: [0, 120] };
      MORPH.saved.push(grow);
      MORPH.saved.push({ kind: "fly", at: so, dur, from: rect("saved", "poster"), to: dp, capA, capB, ride: grow });
      // The page then plays on from the frame the grow ends on.
      MAP.saved.splice(3, 0, [so - SHOT_START.saved + dur, capB, "stretch"]);
    }
    // The link to Watch & read: the film's poster leaves the top of its page and flies down into its place as the first
    // cover in the Films row, while Watch & read (already at the Films row) grows open around it from where the poster
    // was. The banner crop of the item page turns into the cover crop on the way (same art, both fitted to the rect).
    const lt = hasEv("saved", "linkTap") ? evF("saved", "linkTap") : null, wp = rect("saved", "watchPoster");
    if (lt !== null && wp) {
      const dur = 640, se = capEv("saved", "scrollEnd") ?? capEv("saved", "filmRowVisible") ?? capEv("saved", "linkTap") + 2200;
      const capB = se + 2 * FRAME;
      // The page as it stood just before the tap (the capture's frame at the moment the film reaches the tap).
      const capA = Math.min(capEv("saved", "linkTap") - 2 * FRAME, capTime("saved", lt - SHOT_START.saved - 1));
      // Watch & read opens out of the poster's own box on the camera's lopsided curve (no page fade: two layouts are
      // never blended), while the poster flies down to its place in it.
      const gw = g("saved", lt, dur, rect("saved", "detailPoster"), full, capA, capB);
      gw.ease = "lop"; gw.fadeA = [0, 0.3]; // the old page fades out under the opening (no band sandwiched in it)
      MORPH.saved.push(gw);
      // The poster lifts off 120 ms after the tap. `slot`: until it lands, its place in the row is an empty outlined
      // slot in the page's own colour (no second copy of the poster, no grey block).
      MORPH.saved.push({ kind: "fly", at: lt, delay: 120, dur: 720, from: rect("saved", "detailPoster"), to: wp, capA, capB, mixAt: [0.1, 0.5],
        // its place in the row is the page's own background until it lands (no second copy of the poster)
        slot: { background: "rgb(243, 244, 248)", boxShadow: "none", borderRadius: "8px" } });
      MAP.saved.push([lt + dur - SHOT_START.saved, capB, "stretch"]);
    }
    // (pushed last, so the earlier morphs keep their event names) Saved: the new film card grows out of the paste field (260 ms, outCubic) on the frame the list re-renders, instead
    // of appearing in one frame; its place in the list is the list's background until it lands.
    {
      const sv = M.saved, cov = sv && (sv.covers || []).find((h) => h.at === "add"), nc = rect("saved", "newCard"), si = rect("saved", "input");
      if (cov && nc && si && hasEv("saved", "cardLand")) {
        const swapCap = (cov.from + Math.ceil((cov.to - cov.from + 1) / 2)) * FRAME + 1, at = filmOfCap("saved", swapCap) - 1, cb = capEv("saved", "cardLand") + FRAME;
        // Only the poster flies: from a 44-unit square at the left of the field (cover-fitted, never stretched) to its
        // place at the head of the card, 360 ms on the lopsided curve. The rest of the card is uncovered where it
        // stands, top to bottom over the same 360 ms (its text is never scaled); until then it is the list's background.
        const po = rect("saved", "poster"), bg = "rgb(245, 246, 250)", y0 = po.y + po.h, y1 = nc.y + nc.h + 4;
        MORPH.saved.push({ kind: "fly", at, dur: 360, ease: 0.3, from: { x: si.x + 3, y: si.y + 3, w: 44, h: 44 }, to: po, srcRect: po, capA: cb,
          slot: { background: bg, boxShadow: "none", borderRadius: "16px 16px 0 0" },
          cover: (pp) => { const e = lopP(pp, 0.3); return { rect: { x: nc.x - 2, y: y0 + (y1 - y0) * e, w: nc.w + 4, h: (y1 - y0) * (1 - e) }, color: bg, o: pp < 1 ? 1 : 0, radius: "0" }; } });
      }
    }
    //@@MORPHS_NEW
    // Music: the playlist tile is carried into its sheet: the sheet starts with its own "ER" thumbnail on the tile and
    // slides home as it grows; the opening starts in the tile's maroon and clears to the sheet (no pop, no white).
    const mo = evF("music", "open"), sth = rect("music", "sheetThumb");
    const gm = g("music", mo, sth ? 520 : 300, rect("music", "tile"), rect("music", "sheet"), capEv("music", "open") - FRAME, MAP.music[2][1], sth || undefined);
    if (sth) { gm.fill = { color: TILE_MAROON, from: 0.15, to: 0.55 }; gm.shift0 = [rect("music", "tile").x - sth.x, rect("music", "tile").y - sth.y]; }
    MORPH.music.push(gm);
    // (Team 1's dashed line is not wiped in: the chart rescales when the target is added, so the chart as it was and
    // the chart as it is do not register; the panel changes in one frame, inside the camera's move.)
    // Hire: the face is carried across both page changes (each a hard swap on a camera move's fastest frame, never a
    // blend): from the chat to "... is on your team" it grows in place; from there it flies to its tile on the Team
    // page. Its place on the new page is that page's own white until it lands. Ears included (they stand above the
    // tile); the crop is the old page's all the way (the two do not register, so they are not mixed in flight).
    const hrm = M.hire && M.hire.rects;
    if (hrm && hrm.characterBig && hrm.newFace && hrm.character && M.hire.frames) {
      const ear = 16 / 72, box = (r) => ({ x: r.x, y: r.y - r.h * ear, w: r.w, h: r.h * (1 + ear) });
      const slot = { background: "rgb(252, 253, 255)", boxShadow: "none", borderRadius: "8px" };
      const capOf = (at) => capTime("hire", at - SHOT_START.hire - 1);
      MORPH.hire.push({ kind: "fly", at: T_SAYS_OUT, dur: 300, from: box(hrm.character), to: box(hrm.characterBig), capA: capOf(T_SAYS_OUT), mixAt: [2, 3], slot, onCap: true });
      // (round 2: onto the Team page it comes in from the left of the column, its own tile from that page, opaque, and
      // ends exactly on its rect at 57900: nothing crosses Wren's card, nothing settles)
      { const to = box(hrm.newFace); MORPH.hire.push({ kind: "fly", at: T_TEAM_IN, dur: 300, from: { x: to.x - 120, y: to.y, w: to.w, h: to.h }, to, srcRect: to, capA: capLen("hire") - FRAME, mixAt: [2, 3], slot, onCap: true, hold: true }); }
    }
    // Flows: Athena's suggestion card is carried into the flow it makes: the flow page grows out of the card, starting
    // shifted so the flow's own name (or its chain of steps) sits where the card's was, and slides home on the camera's
    // curve; the steps are whole on 62400. Never a blend of the two pages.
    if (M.flow && M.flow.frames) {
      const fr = M.flow.rects || {}, sug = rect("flow", "sug"), dur = T_FLOW_STEPS - T_FLOW_TAP;
      const cov = (M.flow.covers || []).find((h) => h.at === "open" || h.at === "make" || h.at === "makeTap");
      const capB = Math.max(capEv("flow", "steps") ?? 0, cov ? (cov.to + 1) * FRAME + 1 : (capEv("flow", "opened") ?? capEv("flow", "make") + 500));
      // (carried by its head: the flow's title "Birthday heads-up" starts where the suggestion's title was, the card's own
      // left edge kept, so no part of the clip ever falls outside the new page)
      const pairA = fr.sugTitle, pairB = fr.flowTitle || fr.flowName;
      const fromB = pairA && pairB ? { x: sug.x, y: pairB.y - (pairA.y - sug.y), w: sug.w, h: sug.h } : undefined;
      const gf = g("flow", T_FLOW_TAP, dur, sug, full, capEv("flow", "make") - FRAME, capB, fromB);
      if (!fromB) gf.ease = "lop";
      else {
        // The page rides the camera: its title moves on screen along one lopsided curve from where the suggestion's title
        // was to where it rests when the grow ends (the camera zooming out cannot keep up with a plain slide).
        const tyA = pairA.y, tyB = pairB.y, t0 = T_FLOW_TAP, t1 = T_FLOW_STEPS;
        const scr = (t, wy) => { const cam = cameraAt(t); return [H / 2 + (CARDS.flow.y + wy - cam.y) * cam.z, cam]; };
        gf.shiftFn = (t) => {
          const p = prog(t, t0, t1);
          if (p >= 1) return [0, 0];
          const sy = lerp(scr(t0, tyA)[0], scr(t1, tyB)[0], lopP(p, 0.35)), cam = cameraAt(t);
          return [0, cam.y + (sy - H / 2) / cam.z - CARDS.flow.y - tyB];
        };
      }
      MORPH.flow = [gf];
      MAP.flow.splice(2, 0, [T_FLOW_STEPS - SHOT_START.flow, capB, "stretch"]);
    }
    // Every time map must run forward in film time.
    for (const [shot, A] of Object.entries(MAP)) for (let i = 1; i < A.length; i++) if (A[i][0] <= A[i - 1][0]) throw new Error(`MAP.${shot} not in order at ${i}`);
  }

  // ---------- camera ----------
  // A pose is {x, y, z}: the world point at the centre of the frame, z = film px per world unit.
  let MOVES = [], CAM0 = null;
  const ZMAX = {}; // per shot: the zoom at which a capture pixel is 1.25 film px
  const zcap = (shot, z) => Math.min(z, ZMAX[shot] || 3.75);
  function buildCamera() {
    // A pose on a card. Between ~2.1x and 2.44x a centred card shows a sliver of its neighbours (cut-off text at the
    // frame's edges), so a pose in that band is pushed in to 2.44x, where the neighbours sit just outside the frame.
    const NOSLIVER = (W / 2) / (CW / 2 + GAP) + 0.06; // ~25 px clear of the neighbours, wobble included
    const c = (name, x, y, z) => {
      let zz = zcap(name, z);
      if (zz > 2.1 && zz < NOSLIVER && Math.abs(x - CW / 2) < 30) zz = Math.min(NOSLIVER, ZMAX[name] || 3.75);
      return { x: CARDS[name].x + x, y: CARDS[name].y + y, z: zz };
    };
    const mv = [];
    // A move to `pose`, starting at s, ramping up for a, settling for b. `label` marks the moves the music hears.
    const move = (label, s, a, b, pose, k = 0) => { mv.push({ label, s, a, b, pose, k }); return pose; };
    let last;
    // A slow drift on from the last pose (never fully still): zoom by dz, shift by dx,dy world units.
    // Holds lean toward the next card (rightward along the top row), so the next move starts from a crawl, not from rest.
    const drift = (s, e, dz = 1.045, dx = 10, dy = 0) => {
      if (e - s < 500) return;
      last = move(null, s, (e - s) * 0.45, (e - s) * 0.55, { x: last.x + dx, y: last.y + dy, z: last.z * dz });
    };
    const to = (label, s, a, b, pose, k = 0) => { last = move(label, s, a, b, pose, k); };

    // 1-2: the wall is not there yet; the camera waits where tile 1 is the Home card in miniature.
    const z0 = TILE.size / CW;
    const far = { x: CARDS.home.x + CW / 2 - (tileX(0, 8) - W / 2) / z0, y: CARDS.home.y + CH / 2 - (TILE.y - H / 2) / z0, z: z0 };
    CAM0 = far; last = far;
    // Pre-push while the pointer heads for tile 1: it drifts toward the centre and grows a little.
    to(null, 6300, 900, 1500, { x: lerp(far.x, CARDS.home.x + CW / 2, 0.5), y: lerp(far.y, CARDS.home.y + CH / 2, 0.3), z: z0 * 1.22 });
    // 3: the dive. Lands on Home by ~9300 framing the train, carries straight on into the tight framing.
    const train = rect("home", "trainRow"), chip = rect("home", "lateChip");
    const trainC = [train.x + train.w / 2, train.y + train.h / 2];
    // The dive lands straight on the tight crop (no flight rows on the way in): the chips, the card's head, the train
    // row and its booking code; the bottom edge in the gap above the flight row. Before the live update (11400) that
    // row starts 16 px higher (y 571 on the capture), so the edge sits at 568 throughout.
    // With the live-update capture: top edge just above the Ask bar (y 238, its send button whole), bottom at 568.
    const live = M.home && M.home.rects && M.home.rects.chipBefore;
    // (measured from the chip: the app's Home has moved down since; the crop keeps its 330 units from 278 above the
    // chip's top to 52 below it)
    const hb = live ? live.y + 51.9 : 0;
    const homeBot = live ? hb : train.y + train.h + 2, zH = live ? H / 330 : zcap("home", 3.9);
    // Reaches the crop by ~8800 (a long-out settle would show the flight row on the way in).
    to("dive", 7200, 950, 650, c("home", CW / 2, homeBot - (H / 2) / zH, zH));
    drift(8800, 11500, 1.015, 0, -1);
    drift(11500, 13900, 1.03, 4, -2);
    // 4: Ask. Arrive on the field as the question starts typing; after send, one push up and in to the answer.
    const input = rect("ask", "input");
    to("home-ask", 13500, 900, 1500, c("ask", CW / 2, input.y + input.h / 2 - 70, 2.75));
    const tSend = evF("ask", "send");
    drift(tSend - 1500, tSend + 400, 1.03, 0, -6);
    const af = rect("ask", "answerFirst") || rect("ask", "answer"), at = rect("ask", "answer");
    // After send, up to where Athena's steps tick by (a wider frame), then on in, without stopping, to the answer:
    // its opening sentence as large as the full line width allows (the capture is 6x), its fastest moment on 19200.
    const qb = rect("ask", "question"), stp = rect("ask", "steps");
    if (qb && stp) {
      // After send: the sent question ("What did Elena say about pricing?") and Athena's steps under it, both in frame
      // (no climb into empty page), leaving as the steps tick.
      const sy0 = qb.y - 24, sy1 = stp.y + stp.h + 24;
      to("ask-steps", tSend - 120, 480, 1000, c("ask", CW / 2, (sy0 + sy1) / 2, Math.min((0.8 * H) / (sy1 - sy0), 3.3)));
    } else to("ask-steps", tSend + 350, 600, 1200, c("ask", CW / 2, af.y + 70, 3.3));
    // The answer: as large as fits with margins (at least 60 px either side of the text, so nothing is cropped), the top
    // just above its first line and the bottom edge in the gap between two lines, never through one. x stays locked.
    const zA = zcap("ask", Math.min((0.6 * H) / Math.max(40, af.h), (0.86 * W) / at.w));
    const lineH = (M.ask && M.ask.rects && M.ask.rects.lineH) || 21.1; // 15 px type at 1.4
    // Top edge: in the gap between the sent question and the steps line when both are measured (the steps line, the
    // answer and its first source then fit, the bottom edge falling in the gap under that source).
    const hv = H / zA, ansTop = qb && stp ? (qb.y + qb.h + stp.y) / 2 : at.y - 0.9 * lineH;
    const nLines = Math.floor((ansTop + hv - at.y) / lineH - 0.1);
    const ansBot = qb && stp ? ansTop + hv : Math.min(at.y + at.h + 0.5 * lineH, at.y + nLines * lineH + 0.08 * lineH);
    const ansPose = c("ask", at.x + at.w / 2, ansBot - hv / 2, zA);
    to("ask-answer", 18450, 750, 1500, ansPose);
    drift(20300, 23400, 1.02, 0, 2);
    // 5: Saved film. Arrive on the field for the paste; the new card; its page; then Watch & read.
    const sIn = rect("saved", "input"), sNew = rect("saved", "newCard"), dP = rect("saved", "detailPoster"), mB = rect("saved", "moveBtn");
    to("ask-saved", 23100, 900, 1500, c("saved", CW / 2, sIn.y + sIn.h / 2 + 70, 2.6));
    // Push in (~1.45x) on the paste row as the link goes in, so the link and the new card read at phone size.
    to(null, 24900, 500, 1100, c("saved", sIn.x + sIn.w / 2 - 6, sIn.y + sIn.h / 2 + 60, 3.75));
    const tLand = evF("saved", "cardLand") ?? evF("saved", "add") + 300;
    // Down and in on the film card as it lands.
    to("saved-card", tLand - 500, 600, 1200, c("saved", clamp(sNew.x + sNew.w / 2 + 40, 140, 250), sNew.y + sNew.h / 2, Math.min((0.8 * H) / sNew.h, 3.2)));
    const tOpen = evF("saved", "open"), tMove = evF("saved", "move");
    // Its page: from the poster's top to the Move button, the camera leaving 150 ms before the tap.
    const top = Math.min(dP.y, mB.y), bot = Math.max(dP.y + dP.h, mB.y + mB.h);
    // At NOSLIVER (no neighbouring card in frame), bottom edge just under the Move button it will tap; the banner's top
    // goes out of frame.
    to("saved-open", tOpen - 250, 460, 950, c("saved", CW / 2, bot + 8 - (H / 2) / NOSLIVER, NOSLIVER));
    // After Move: in on "Filed in Watch & read" and the poster above it.
    const fl = rect("saved", "filed");
    to("saved-filed", tMove - 350, 600, 1400, c("saved", CW / 2, (dP.y + dP.h * 0.5 + fl.y + fl.h) / 2 + 10, Math.min((0.9 * H) / (fl.y + fl.h - dP.y - dP.h * 0.5 + 40), 3.0)));
    // The link: down and in with the poster to the Films row on Watch & read ("Up next" above it, the film first).
    const wp = rect("saved", "watchPoster"), fr = rect("saved", "filmRow") || rect("saved", "watchCard");
    if (wp && hasEv("saved", "linkTap")) {
      // Framed so the page's "Watch & read" title is at the top and the frame's bottom edge sits in the gap under the
      // covers: cause (Move to Watch & read) and effect (the film first on Watch & read) in one view.
      // (cut 6: on the current page the title sits 268 above the covers; top edge 7 above the title, bottom edge 2.3 under
      // the covers, at ~2.46x: neighbours still ~5 units clear)
      const tLink = evF("saved", "linkTap"), wTop = wp.y - 275, wBot = wp.y + wp.h + 2.3, zW = H / (wBot - wTop);
      to("saved-watch", tLink - 80, 380, 800, { x: CARDS.saved.x + CW / 2, y: CARDS.saved.y + (wTop + wBot) / 2, z: zW });
    } else drift(tMove + 1400, 30500, 1.04, 12);
    // 6: Team 1, "Tell me when": the saved gift idea's page. Lands on its header (the shop, "Cedar & sage hand balm,
    // 75ml") with the Tracking panel's sentence and chart under it, and holds; then in on the sentence, the chart and
    // the "Tell me when" toggle; eases down as the form opens under it (the chart stays in frame); once "Tell me" is
    // pressed, back up and in on the sentence, the chart with its dashed "Your £28" line and the pill.
    const tk = M.track && M.track.rects;
    if (tk) {
      const sb = tk.sentenceBefore, tb = tk.tellMeWhenBtn, fm = tk.form, chT = tk.chart, pl2 = tk.pill;
      const hd = tk.header || { y: sb.y - 190 }, ft = tk.footBefore || tk.foot;
      // (from just above the title to just under the toggle, so the toggle is already in frame for its tap on 33000)
      const g0 = (tk.title ? tk.title.y : hd.y + 26) - 14, g1 = Math.max(ft.y + ft.h + 11, tb.y + tb.h + 8);
      to("saved-track", 30300, 900, 850, c("track", CW / 2, (g0 + g1) / 2, H / (g1 - g0)));
      const a0 = sb.y - 30, a1 = tb.y + tb.h + 36;
      to("track-in", 32500, 400, 500, c("track", CW / 2, (a0 + a1) / 2, H / (a1 - a0)));
      // The form opens under the toggle: first down to its "At or under" row, the bottom edge in the gap above the
      // amount field (its grey placeholder stays out of frame); the field comes into frame as the 28 is typed, so
      // the entry reads as one.
      const b0 = chT.y - 12, b1 = fm.y + fm.h + 12, seg = tk.atOrUnderBtn, fld = tk.amountField;
      const m1 = seg.y + seg.h + Math.min(3, (fld.y - seg.y - seg.h) / 3), m0 = sb.y + sb.h + 4;
      to("track-form", evF("track", "tellMeWhen") - 80, 300, 500, c("track", CW / 2, (m0 + m1) / 2, H / (m1 - m0)));
      to("track-field", evF("track", "typeStart") - 330, 280, 520, c("track", CW / 2, (b0 + b1) / 2, H / (b1 - b0)));
      const c0 = sb.y - 9, c1 = pl2.y + pl2.h + 16;
      to("track-set", evF("track", "tellMe") - 170, 450, 800, c("track", CW / 2, (c0 + c1) / 2, H / (c1 - c0)));
      drift(35050, 35500, 1.01, 2, 0);
    } else to("saved-track", 30300, 900, 1500, c("track", CW / 2, 400, 2.6));
    // 7: Music. Land on Playlists; the camera starts for the sheet 300 ms before the tap.
    const pl = rect("music", "playlists"), tile = rect("music", "tile"), sheet = rect("music", "sheet");
    to("track-music", 35400, 600, 1500, c("music", pl.x + pl.w / 2, pl.y + pl.h / 2, Math.min((0.86 * H) / pl.h, 2.9)));
    const tMo = evF("music", "open");
    // The sheet's head (title, Open in Spotify, top artists), the camera leaving 300 ms before the tap.
    const sh0 = sheet.y, sh1 = Math.min(sheet.y + sheet.h, sheet.y + 400);
    to("music-open", tMo - 450, 600, 1300, c("music", CW / 2, (sh0 + sh1) / 2, Math.min((0.9 * H) / (sh1 - sh0), 2.7)));
    const sp = rect("music", "spotify") || rect("music", "spotifyBtn");
    if (sp && hasEv("music", "spotify")) {
      // In on "Open in Spotify" for the press on 39600.
      const tSp = evF("music", "spotify");
      // Push in (~1.5x) on the button for its press: 39100-39900.
      to(null, tSp - 500, 400, 800, c("music", sp.x + sp.w / 2 + 50, sp.y + sp.h / 2 + 10, 3.75));
    } else drift(tMo + 1300, 40000, 1.04, 10);
    // 8: Habits.
    const tick = rect("habits", "tick");
    const cl = rect("habits", "countLine") || rect("habits", "streak");
    if (cl) {
      // The run's card: its tick and its count line ("… 20 in a row now"), pushed in so both read.
      const hy0 = Math.min(tick.y, cl.y) - 24, hy1 = Math.max(tick.y + tick.h, cl.y + cl.h) + 24;
      to("music-habits", 39900, 900, 1100, c("habits", CW / 2, (hy0 + hy1) / 2, Math.min((0.8 * H) / (hy1 - hy0), (0.86 * W) / CW, 3.6)));
      drift(41300, T_HABITS_CUT - FRAME, 1.06, 0, 2);
    } else {
      to("music-habits", 39900, 900, 1500, c("habits", CW / 2, tick.y + tick.h / 2 + 50, 2.6));
      drift(41300, T_HABITS_CUT - FRAME, 1.04, 0, 6);
    }
    // 9: Team 2. Down to Home again (the card under Habits): the Ask box, the Athena · Penny · Dot · Wren chips and,
    // once Penny's chip is tapped, her working line under them. The greeting above stays out of frame.
    const wk = M.work && M.work.rects, wdn = M.workDone && M.workDone.rects;
    if (wk) {
      const zc = Math.min((0.86 * W) / (wk.askBox.w + 20), 4.4), top = wk.askBox.y - 10;
      // Habits holds to the last frame before 43200; a hard cut on the downbeat (between two frames, so no blur sample
      // straddles it) to the chips, a touch wide, and a 600 ms settle in. After the tap, a push in on the chips and
      // her working line.
      const chipsPose = c("work", CW / 2, top + H / 2 / zc, zc), pre = { x: chipsPose.x, y: chipsPose.y, z: chipsPose.z / 1.03 };
      last = pre; mv.push({ label: "habits-cut", cut: true, s: T_HABITS_CUT - FRAME / 2, a: 0, b: 0, pose: pre, k: 0 });
      to(null, T_HABITS_CUT - FRAME / 2, 0, 600, chipsPose);
      to(null, T_PENNY_TAP - 60, 300, 800, c("work", CW / 2, top + H / 2 / 5, 5));
      drift(45000, 45900, 1.015, -3, 0);
    }
    if (wdn) {
      // Left to the gift idea's Tracking panel exactly as Team 1 left it (the sentence, the chart with the dashed line,
      // the pill). Then one ease out and up to the whole page head, its fastest frame the step down on 48000: it lands
      // with the item's title at the top and "Penny checked 1 minute ago" inside the bottom edge, and holds.
      const sb = wdn.sentenceBefore, pb = wdn.pillBefore, rl = wdn.reachedLine;
      const ti = wdn.title || (tk && tk.title) || { y: rl.y - 167, h: 63 }, fa = wdn.foot;
      const p0 = sb.y - 9, p1 = pb.y + pb.h + 16;
      to("work-done", 45900, 700, 900, c("workDone", CW / 2, (p0 + p1) / 2, H / (p1 - p0)));
      const hd2 = wdn.header || (tk && tk.header) || { y: ti.y - 27 }, q0 = hd2.y - 9, q1 = fa.y + fa.h + 12;
      to("done-out", T_STEP_DOWN - 550, 550, 500, c("workDone", CW / 2, (q0 + q1) / 2, H / (q1 - q0)));
      // Once the title has been read (to ~48600), in on the "£27 at Fenn & Hale ..." line and the chart, "Penny checked
      // 1 minute ago" still inside the bottom edge; held to the move away.
      const r1 = fa.y + fa.h + 9, r0 = rl.y - 62;
      to("done-in", 48550, 300, 450, c("workDone", CW / 2, (r0 + r1) / 2, H / (r1 - r0)));
      drift(49300, 49850, 1.01, -2, 0);
    }
    // 10: Team 3, hire. The "New assistant" sheet: the waiting silhouette, "What's the job?" and the field as the
    // sentence is typed; the frame stays there for the press on Continue (below the frame) and eases to the chat's
    // framing while the silhouette thinks; the assistant appears in the silhouette's place on 55200. (The neighbouring
    // cards are hidden while the camera is on this card, so the Team page's taller frame shows no slivers of them.)
    const hr = M.hire && M.hire.rects;
    if (hr) {
      const h0 = hr.silhouette.y - 14, h1 = hr.input.y + hr.input.h + 12, tSub = evF("hire", "submit");
      const top = c("hire", CW / 2, (h0 + h1) / 2, H / (h1 - h0));
      to("done-hire", 49850, 550, 1100, top);
      drift(51500, tSub + 100, 1.035, 0, 1);
      // (round 2: the frame stays on the silhouette and the sentence, its bottom edge above "Or start from one of
      // these": the suggestions under it name a real product. The pointer goes down out of frame to Continue; the press
      // is heard, and seen in the plate turning to "Reading the job...")
      // (the frame for the chat: from above its ears to under its second line, the reply chips below out of frame)
      const s0 = hr.character.y - hr.character.h * 0.22 - 12, s1 = hr.saysLine.y + hr.saysLine.h + 7;
      const chat = c("hire", CW / 2, (s0 + s1) / 2, H / (s1 - s0));
      to("hire-up", tSub + 150, 350, 450, { x: chat.x, y: chat.y, z: chat.z / 1.035 });
      to("hire-arrive", T_ARRIVE - 200, 200, 500, chat);
      // "... is on your team": in on the large face, its bubble and the line (the swap on this push's fastest frame).
      const d0 = hr.characterBig.y - 44, d1 = hr.joinedLine.y + hr.joinedLine.h + 12;
      to("hire-joined", T_SAYS_OUT - 250, 250, 450, c("hire", CW / 2, (d0 + d1) / 2, H / (d1 - d0)));
      // The Team page: the newest two of the team whole (Wren and the new assistant); Dot's card, above, out of frame.
      const fc = hr.faces || [], wren = fc.length > 1 ? fc[fc.length - 2] : null, nc2 = hr.newCard;
      const t0 = (wren ? wren.y - 21 : nc2.y - 240) - 8, t1 = nc2.y + nc2.h + 8;
      to("hire-team", T_TEAM_IN - 250, 250, 450, { x: CARDS.hire.x + CW / 2, y: CARDS.hire.y + (t0 + t1) / 2, z: H / (t1 - t0) });
      drift(58150, 59000, 1.02, 0, 0);
      // (held 57900-59100 with both whole; then a push in on the new face's card, "... first run is Monday at 9:00",
      // at the zoom the Flows page is framed at, so the step left to it is a pan at one zoom: nothing above the
      // suggestion card crosses the frame's top edge while the camera settles)
      const ncd = hr.newCard, zN = Math.min(H / (ncd.h + 60), ZMAX.hire || 3.75, H / 288);
      to("team-acorn", 59000, 350, 700, { x: CARDS.hire.x + CW / 2, y: CARDS.hire.y + ncd.y + ncd.h / 2, z: zN });
    }
    // 11: Flows. One step left to the Flows page (its fastest frame on 60000), framed on Athena's suggestion: the
    // sentence, the flow it proposes and "Make it a flow". On the tap the camera rides the card into the flow page,
    // framing its steps and the switch; then holds (a drift) to the pull-back.
    {
      // The suggestion card whole: top edge in the gap above it (the first suggestion's buttons out of frame), bottom
      // edge in the gap under it, above "Your flows" (measured on the capture: gaps 331-343 and 558-619).
      const sug = rect("flow", "sug"), s0 = sug.y - 8.7, s1 = Math.min(sug.y + sug.h + 60, s0 + H / 3.6);
      to("team-flows", T_FLOWS - 650, 650, 1050, { x: CARDS.flow.x + CW / 2, y: CARDS.flow.y + (s0 + s1) / 2, z: H / (s1 - s0) });
      drift(T_FLOWS + 1100, T_FLOW_TAP - 150, 1.03, 0, 0);
      // The flow: its title, the On switch, When ... and Then ... whole; the bottom edge in the gap above "Test on the
      // last date". Its neighbours are away by now (faded while off frame), so this wider frame shows the page alone.
      const st = rect("flow", "steps"), ft = rect("flow", "flowTitle") || rect("flow", "flowHead") || st;
      const f0 = Math.min(st.y, ft.y) - 12, f1 = st.y + st.h - 5; // (just above the Then card's divider: "Gift ideas for the person" whole)
      to("flow-open", T_FLOW_TAP - 100, 250, 900, { x: CARDS.flow.x + CW / 2, y: CARDS.flow.y + (f0 + f1) / 2, z: H / (f1 - f0) }, 6); // (fast early: the framing is nearly reached as the grow ends on 62400)
      drift(T_FLOW_STEPS + 1200, T.pull - 600, 1.03, 0, 0);
    }
    // 12: the pull-back, fast early so most of the reveal lands on the 64800 downbeat, a long settle after.
    const zWall = 0.9 * Math.min(H / WALL.h, W / WALL.w);
    to("pullback", T.pull - 600, 300, 2600, { x: WALL.cx, y: WALL.cy, z: zWall }, 6);
    // Drift in to 1.10x until the wall goes.
    drift(T.pull + 1200, T.pull + 4300, 1.1, -60, 30);
    // The wall falls; the camera tilts down after it.
    to("wall-exit", T.wallFall - 100, 450, 800, { x: last.x, y: last.y + 260, z: last.z * 1.02 });

    // Each move runs from the previous move's pose.
    let prev = far;
    for (const m of mv) { m.from = prev; prev = m.pose; m.dl = Math.log(m.pose.z / m.from.z); }
    MOVES = mv;
  }
  // `cutT`: the time at which hard cuts are judged (camSpeed judges both ends of a frame at its start, so a cut never
  // reads as travel and never brings motion blur).
  function cameraAt(t, cutT = t) {
    let lz = Math.log(CAM0.z), x = CAM0.x, y = CAM0.y;
    for (const m of MOVES) {
      if (m.cut) {
        if (cutT <= m.s) continue;
        lz += m.dl; x += m.pose.x - m.from.x; y += m.pose.y - m.from.y;
        continue;
      }
      if (t <= m.s) continue;
      const e = m.k ? lopX(t, m.s, m.a, m.b, m.k) : lop(t, m.s, m.a, m.b);
      if (e <= 0) continue;
      lz += m.dl * e;
      // Zoom-compensated: a point on the wall travels straight on screen while the camera zooms.
      let u = e;
      if (Math.abs(m.dl) > 1e-4) { const z = m.from.z * Math.exp(m.dl * e); u = (1 / z - 1 / m.from.z) / (1 / m.pose.z - 1 / m.from.z); }
      x += (m.pose.x - m.from.x) * u; y += (m.pose.y - m.from.y) * u;
    }
    const z = Math.exp(lz);
    // Always very slightly moving.
    const sx = 4 * Math.sin(t / 3100), sy = 3 * Math.cos(t / 2700);
    return { x: x + sx / z, y: y + sy / z, z };
  }
  const project = (cam, wx, wy) => [W / 2 + (wx - cam.x) * cam.z, H / 2 + (wy - cam.y) * cam.z];
  // Fastest on-screen travel of a world point between this frame and the next, px per frame (over the frame's corners and centre).
  function camSpeed(t) {
    const a = cameraAt(t, t), b = cameraAt(t + FRAME, t);
    let best = 0;
    for (const [sx, sy] of [[W / 2, H / 2], [0.08 * W, 0.08 * H], [0.92 * W, 0.08 * H], [0.08 * W, 0.92 * H], [0.92 * W, 0.92 * H]]) {
      const wx = a.x + (sx - W / 2) / a.z, wy = a.y + (sy - H / 2) / a.z;
      const [px, py] = project(b, wx, wy);
      best = Math.max(best, Math.hypot(px - sx, py - sy));
    }
    // The wall's own fall counts as camera travel for the blur.
    if (t > T.wallFall && t < T.wallFall + 1200) best = Math.max(best, wallFallSpeed(t));
    return best;
  }

  // ---------- opening: orb, tiles, first line (drawn in 1920x1080 coordinates at the camera's first pose) ----------
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
  const tileT = (i) => T.tile0 + i * T.tileStep;
  const TILE_MAROON = "rgb(124, 65, 67)"; // the "Evening run" playlist tile
  const tileCount = (t) => { let n = 0; for (let i = 0; i < 8; i++) n += outExpo(prog(t, tileT(i), tileT(i) + 420)); return Math.max(1, n); };
  const tileX = (i, n) => W / 2 + (i - (n - 1) / 2) * TILE.pitch;
  const slotX = (i) => tileX(i, Math.max(1, i)); // where tile i pops, before the row re-centres
  const ORB1 = { x: W / 2, y: 340 };
  // The opening layer moves with the camera: a point drawn at (sx, sy) for the first pose.
  const openXf = (cam) => { const k = cam.z / CAM0.z; return { k, tx: W / 2 + (CAM0.x - cam.x) * cam.z - (W / 2) * k, ty: H / 2 + (CAM0.y - cam.y) * cam.z - (H / 2) * k }; };
  const openPt = (cam, sx, sy) => { const f = openXf(cam); return [f.tx + sx * f.k, f.ty + sy * f.k]; };

  // ---------- the lines ----------
  const LINE1 = ["Everything", "you'd", "otherwise", "forget"], LINE1_Y = 806;
  const PRE = "Athena remembers the ";
  // swaps.json: [{at, phrase, how}]. At `at` ms the phrase after "Athena remembers the " becomes `phrase`, shown from the
  // nearest frame. how: "type" = typed on, complete by `at`; "retype" = the pointer drags a selection from `at` and
  // it is retyped within 340 ms; "swap" = replaced in place; "final" = the last phrase, also in place.
  let SWAPS = [];
  async function loadSwaps() {
    let data = CFG.swaps;
    if (!data) {
      try { data = await (await fetch("swaps.json")).json(); } catch (e) {
        data = await new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open("GET", "swaps.json"); x.onload = () => { try { res(JSON.parse(x.responseText)); } catch (err) { rej(err); } }; x.onerror = () => rej(new Error("swaps.json could not be loaded")); x.send(); });
      }
    }
    SWAPS = data.slice().sort((a, b) => a.at - b.at);
    // Picture time of each swap: the nearest frame to its `at` (so 150 ms steps alternate 4 and 5 frames).
    SWAPS.forEach((x) => { x.ft = Math.round((x.at * FPS) / 1000) * FRAME; });
    SWAPS.forEach((x, i) => { const next = SWAPS[i + 1]; x.settle = next ? clamp(next.ft - x.ft - FRAME - 1, 20, 80) : 80; });
    const fin = SWAPS.find((x) => x.how === "final") || SWAPS[SWAPS.length - 1];
    T.final = fin.ft;
    window.FILM_SWAPS = SWAPS.map((x) => ({ at: x.at, frame: Math.round((x.at * FPS) / 1000), phrase: x.phrase, how: x.how }));
  }
  const L2 = { y: H / 2, liftY: 262, liftScale: 0.78, drag: 150, dragLead: 40, reAt: 170, reEnd: 340 };
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
  // -> { pre, sel, rest, caret, settle }
  function line2State(t) {
    t += 0.5;
    if (t < T.line2) return null;
    const first = PRE + SWAPS[0].phrase;
    if (t < SWAPS[0].ft) {
      const n = clamp(Math.ceil(((t - T.line2) / (SWAPS[0].ft - 40 - T.line2)) * first.length), 0, first.length);
      return { pre: first.slice(0, Math.min(n, PRE.length)), sel: "", rest: first.slice(PRE.length, n), caret: true, typing: true, settle: 1e9 };
    }
    let i = 0;
    while (i < SWAPS.length - 1 && t >= SWAPS[i + 1].ft - (SWAPS[i + 1].how === "retype" ? L2.dragLead : 0)) i++;
    const cur = SWAPS[i];
    if (cur.how === "retype") {
      const prev = SWAPS[i - 1].phrase;
      if (t < cur.ft + L2.reAt) {
        const n = Math.round(inOut(prog(t, cur.ft - L2.dragLead, cur.ft + L2.drag)) * prev.length);
        return { pre: PRE, sel: prev.slice(0, n), rest: prev.slice(n), caret: false, settle: 1e9 };
      }
      const n = clamp(Math.ceil(((t - cur.ft - L2.reAt) / (L2.reEnd - L2.reAt)) * cur.phrase.length), 1, cur.phrase.length);
      return { pre: PRE, sel: "", rest: cur.phrase.slice(0, n), caret: !SWAPS[i + 1] || SWAPS[i + 1].how === "retype" || t < SWAPS[i + 1].ft - 150, typing: t < cur.ft + L2.reEnd + 150, settle: 1e9 };
    }
    const inPlace = cur.how === "swap" || cur.how === "final";
    return { pre: PRE, sel: "", rest: cur.phrase, caret: cur.how === "type", settle: inPlace ? t - cur.ft : 1e9, settleDur: cur.settle || 80 };
  }

  // ---------- the check-in card (finale) ----------
  let CK = null;
  function buildCheckin() {
    const real = !!(M.checkin && M.checkin.frames);
    const card = rect("checkin", "card"), great = rect("checkin", "great");
    const mood = M.checkin && M.checkin.rects && M.checkin.rects.moodBlock;
    const pad = mood ? 0 : 12;
    const x0 = Math.max(0, card.x - pad), y0 = Math.max(0, card.y - pad);
    const x1 = Math.min(CW, card.x + card.w + pad), y1 = mood ? Math.min(CH, mood.y + mood.h + 14) : Math.min(CH, card.y + card.h + pad);
    const w = x1 - x0, h = y1 - y0;
    const scale = 1180 / w, top = 372, room = H - top - 70;
    const cy = h * scale <= room ? top + room / 2 : top + 6 + (h * scale) / 2;
    // The white circle of the pressed Great step (measured on the capture: centred, its centre 19.5 below the step's
    // top, a third of its width across), the label below it.
    const d = great.w * 0.33;
    const circ = { x: great.x + great.w / 2 - d / 2, y: great.y + 19.5 - d / 2, w: d, h: d };
    if (M.checkin && M.checkin.rects && M.checkin.rects.greatCircle) Object.assign(circ, M.checkin.rects.greatCircle);
    const toScreen = (lx, ly) => [W / 2 + (lx - x0 - w / 2) * scale, cy + (ly - y0 - h / 2) * scale];
    CK = { real, x0, y0, w, h, scale, cx: W / 2, cy, start: T.great - capEv("checkin", "press"), circ, toScreen,
      great: toScreen(great.x + great.w / 2, circ.y + circ.h / 2) };
    const el = $("checkin");
    el.style.width = w + "px"; el.style.height = h + "px";
    el.style.borderRadius = Math.min(24, h * 0.22).toFixed(1) + "px";
    CK.layer = { img: el.firstElementChild, src: null };
    CK.layer.img.style.left = -x0 + "px"; CK.layer.img.style.top = -y0 + "px";
    CK.fly = { img: $("greatfly").firstElementChild, src: null };
    // Where the circle leaves the pressed step: the step's own dark fill closes over the spot.
    if (!CK.hole) { CK.hole = document.createElement("i"); el.appendChild(CK.hole); }
    Object.assign(CK.hole.style, { position: "absolute", left: (circ.x - x0 - 0.6) + "px", top: (circ.y - y0 - 0.6) + "px", width: (circ.w + 1.2) + "px", height: (circ.h + 1.2) + "px", borderRadius: "50%", background: "oklch(0.21 0.012 264)", opacity: "0" });
  }
  function checkinFrame(t) { return clamp(Math.floor(((t - CK.start) * FPS) / 1000 + 1e-6), 0, (M.checkin && M.checkin.frames ? M.checkin.frames : 1) - 1); }
  function checkinSources(t) {
    const look = `${CFG.look}/days.png`;
    if (!CK.real) return [look];
    return [`${CFG.cap}/checkin/${pad4(checkinFrame(t))}.jpg`, look];
  }

  // ---------- pointer ----------
  let PTR = [], PRESS = [];
  function buildPointer() {
    const st = (x, y) => () => [x, y];
    const cd = (name, x, y) => (t) => project(cameraAt(t), CARDS[name].x + x, CARDS[name].y + y);
    const wd = (x, y) => (t) => project(cameraAt(t), x, y);
    const op = (x, y) => (t) => openPt(cameraAt(t), x, y);
    const k = [], pr = [];
    // lead: this key's move leaves from where the pointer was when it set off, not from a point the world drags along.
    const at = (t, pos, bend = 1, lead = false) => k.push({ t, pos, bend, lead });
    const press = (t, hold = 0, ripple = 520) => pr.push({ t, hold, ripple });
    // Rest on a point of a card (pinned to it) from t0 to t1.
    const rest = (t0, t1, pos) => { at(t0, pos, 0); at(t1, pos, 0); };

    // 1: wanders in from lower right, pauses centre, presses: the orb. Then presses the orb again.
    at(0, op(1650, 1190)); at(960, op(ORB1.x + 24, ORB1.y + 34)); press(T.orbPop);
    at(T.orbPop + 100, op(ORB1.x + 24, ORB1.y + 34)); at(1900, op(ORB1.x + 96, ORB1.y + 104), 0.5); at(T.orbPress - 20, op(ORB1.x + 20, ORB1.y + 28), 0.5); press(T.orbPress);
    // 2: taps each tile into being, every half beat.
    at(T.tile0 - 260, op(slotX(0) + 12, TILE.y + 36), 0.6);
    for (let i = 0; i < 8; i++) { at(tileT(i) - 20, op(slotX(i) + 12, TILE.y + 36), i ? 0.4 : 0.6); press(tileT(i)); at(tileT(i) + 90, op(slotX(i) + 12, TILE.y + 36), 0); }
    // Steps aside while the line comes, then heads for tile 1 from 6600.
    at(5900, op(1560, 930), 0.6); at(6550, op(1548, 924), 0);
    at(T.dive - 30, op(tileX(0, 8) + 14, TILE.y + 32), 0.8, true); press(T.dive);
    at(T.dive + 110, op(tileX(0, 8) + 14, TILE.y + 32), 0);
    // 3: leads the dive to the train row: off to where the chip will be, not carried by the zoom.
    const chip = rect("home", "lateChip"), cy = chip.y + chip.h / 2;
    const chipP = cd("home", chip.x + chip.w + 30, cy + 12);
    at(8600, st(1240, 690), 0.5, true);
    at(9700, chipP, 0.3, true);
    rest(9800, 12900, chipP);
    // 4: Ask. Leaves ~1200 ms before the move's peak, swings right; the field slides in under it.
    const tType = evF("ask", "typeStart"), tSend = evF("ask", "send");
    const input = rect("ask", "input");
    let send = rect("ask", "send");
    if (!send || Math.abs(send.y + send.h / 2 - (input.y + input.h / 2)) > 40) send = { x: input.x + input.w + 60, y: input.y, w: 44, h: 44 };
    const inP = [input.x + Math.min(96, input.w * 0.4), input.y + input.h / 2 + 2];
    at(13200, st(1440, 640), 0.4, true);
    at(tType - 90, cd("ask", inP[0], inP[1]), 0.5, true); press(tType - 60);
    at(tType + 200, cd("ask", inP[0], inP[1]), 0); at(tType + 900, cd("ask", inP[0] + 44, inP[1] + 56), 0.5); at(tSend - 650, cd("ask", inP[0] + 44, inP[1] + 56), 0);
    at(tSend - 70, cd("ask", ...mid(send)), 0.6); press(tSend - 40);
    at(tSend + 150, cd("ask", ...mid(send)), 0);
    // Leads the push to the answer: up and right, to rest beside its first line.
    const af = rect("ask", "answerFirst") || rect("ask", "answer");
    const ansRest = cd("ask", Math.min(af.x + af.w + 20, 380), af.y + af.h * 0.55);
    at(tSend + 900, st(1600, 520), 0.4, true);
    at(19300, ansRest, 0.3, true);
    rest(19400, 22700, ansRest);
    // 5: Saved. Off to the right before the move; taps the field as the link lands; the card; Move; the Watch & read link.
    const sIn = rect("saved", "input"), sNew = rect("saved", "newCard"), mB = rect("saved", "moveBtn"), fl = rect("saved", "filed");
    const tP = evF("saved", "paste") ?? evF("saved", "typeStart"), tAdd = evF("saved", "add"), tOpen = evF("saved", "open"), tMove = evF("saved", "move");
    const sP = [sIn.x + Math.min(120, sIn.w * 0.4), sIn.y + sIn.h / 2 + 2];
    at(22800, st(1500, 600), 0.4, true);
    at(tP - 120, cd("saved", sP[0], sP[1]), 0.5, true); press(tP - 80, 120);
    at(tP + 260, cd("saved", sP[0], sP[1]), 0);
    if (tAdd > tP + 400) { at(tAdd - 80, cd("saved", sIn.x + sIn.w - 22, sIn.y + sIn.h / 2), 0.5); press(tAdd - 40); at(tAdd + 160, cd("saved", sIn.x + sIn.w - 22, sIn.y + sIn.h / 2), 0); }
    const cardP = cd("saved", sNew.x + sNew.w * 0.6, sNew.y + sNew.h * 0.55);
    at(tOpen - 70, cardP, 0.5); press(tOpen - 40);
    at(tOpen + 140, cardP, 0);
    const moveP = cd("saved", mB.x + mB.w * 0.42, mB.y + mB.h / 2 + 2);
    at(tOpen + 900, moveP, 0.5); at(tMove - 70, moveP, 0); press(tMove - 40);
    at(tMove + 160, moveP, 0);
    const flk = rect("saved", "filedLink"), wpR = rect("saved", "watchPoster");
    if (flk && wpR && hasEv("saved", "linkTap")) {
      // Taps "Watch & read" in "Filed in Watch & read", then follows the poster down to rest beside its cover.
      const tLink = evF("saved", "linkTap"), linkP = cd("saved", flk.x + flk.w * 0.55, flk.y + flk.h / 2 + 2);
      at(tLink - 70, linkP, 0.5); press(tLink - 40); at(tLink + 120, linkP, 0);
      const coverP = cd("saved", wpR.x + wpR.w + 26, wpR.y + wpR.h * 0.72);
      at(tLink + 560, coverP, 0.5); rest(tLink + 600, 30020, coverP);
    } else {
      const filedP = cd("saved", Math.min(fl.x + fl.w * 0.78, 330), fl.y + fl.h + 26);
      at(tMove + 900, filedP, 0.4); rest(tMove + 1000, 29900, filedP);
    }
    // 6: Team 1. Heads right; the Tracking panel arrives under it; taps "Tell me when", "At or under", waits by the
    // field while 28 goes in, taps "Tell me", then rests under the new pill.
    at(30300, st(1560, 760), 0.4, true);
    const tkr = M.track && M.track.rects;
    if (tkr) {
      const P = (r, fx = 0.5, fy = 0.5, dx = 0, dy = 0) => cd("track", r.x + r.w * fx + dx, r.y + r.h * fy + dy);
      const tW = evF("track", "tellMeWhen"), tU = evF("track", "atOrUnder"), tTy = evF("track", "typeStart"), tM = evF("track", "tellMe");
      const pW = P(tkr.tellMeWhenBtn, 0.55, 0.55), pU = P(tkr.atOrUnderBtn, 0.55, 0.6), pF = P(tkr.amountField, 1, 0.6, 22, 4), pM = P(tkr.tellMeBtn, 0.55, 0.6);
      // Arrives beside the title and waits there while it is read; then down to the toggle.
      const tiR = tkr.title, tiP = tiR ? P(tiR, 0.78, 1, 0, 14) : pW;
      at(31600, tiP, 0.4, true); at(32300, tiP, 0);
      at(tW - 80, pW, 0.4, true); press(tW - 40); at(tW + 130, pW, 0);
      at(tU - 70, pU, 0.5); press(tU - 40); at(tU + 130, pU, 0);
      at(tTy - 60, pF, 0.4); at(tM - 200, pF, 0);
      at(tM - 70, pM, 0.5); press(tM - 40); at(tM + 110, pM, 0);
      const pP = P(tkr.pill, 0, 0.55, -30, 0);
      at(tM + 700, pP, 0.5); rest(tM + 750, 35150, pP);
    }
    // 7: Music: heads right; "Evening run" slides in under it; tapped; rests on the sheet.
    const tile = rect("music", "tile"), sheet = rect("music", "sheet"), tMo = evF("music", "open");
    at(35250, st(1560, 600), 0.4, true);
    const tileP = cd("music", tile.x + tile.w * 0.55, tile.y + tile.h * 0.55);
    at(36900, tileP, 0.3, true); at(tMo - 70, tileP, 0); press(tMo - 40); at(tMo + 120, tileP, 0);
    const spR = rect("music", "spotifyPoint") || (rect("music", "spotify") && mid(rect("music", "spotify")));
    if (spR && hasEv("music", "spotify")) {
      // Rides up with the sheet, then presses "Open in Spotify" on 39600 and holds it 200 ms.
      const spP = cd("music", spR.x !== undefined ? spR.x : spR[0], spR.y !== undefined ? spR.y : spR[1]), tSp = evF("music", "spotify");
      at(tMo + 900, cd("music", 330, sheet.y + 200), 0.4); at(tSp - 500, cd("music", 300, (spR.y !== undefined ? spR.y : spR[1]) + 40), 0.3);
      at(tSp - 70, spP, 0.4); press(tSp - 40, 200); at(tSp + 260, spP, 0);
    } else {
      const shP = cd("music", 360, sheet.y + Math.min(sheet.h, 470) * 0.62);
      at(tMo + 1100, shP, 0.4); rest(tMo + 1200, 39500, shP);
    }
    // 8: Habits: heads right, ticks "Evening run" on 42000.
    const tTick = evF("habits", "tick"), tick = rect("habits", "tick");
    // Leads at the move's peak - 900 ms, arrives on the tick as the camera settles, hovers, ticks on 42000.
    at(39900, st(1800, 520), 0.4, true);
    at(41300, cd("habits", tick.x + tick.w * 0.5 + 14, tick.y + tick.h * 0.5 + 16), 0.4, true);
    at(tTick - 70, cd("habits", ...mid(tick)), 0.3); press(tTick - 40);
    at(tTick + 160, cd("habits", ...mid(tick)), 0);
    // 9: Team 2. Swings down ahead of the drop to Home; taps Penny's chip; waits under her working line; leads left to
    // the Tracking panel and waits by the end of the price line for her check.
    const wkr = M.work && M.work.rects, wdr = M.workDone && M.workDone.rects;
    // Across the hard cut at 43200 it stays where it is on screen (it was resting on the tick), then heads for the chip.
    { const p0 = project(cameraAt(43050), CARDS.habits.x + tick.x + tick.w / 2, CARDS.habits.y + tick.y + tick.h / 2);
      at(43050, st(p0[0], p0[1]), 0.2, true); at(43300, st(p0[0] + 6, p0[1] + 4), 0); }
    if (wkr) {
      const pc = wkr.pennyChip, wl = wkr.workingLine, chipP = cd("work", pc.x + pc.w * 0.6, pc.y + pc.h * 0.62);
      at(T_PENNY_TAP - 80, chipP, 0.4, true); press(T_PENNY_TAP - 40); at(T_PENNY_TAP + 130, chipP, 0);
      const wlP = cd("work", wl.x + wl.w * 0.8, wl.y + wl.h + 16);
      at(T_PENNY_TAP + 800, wlP, 0.5); rest(T_PENNY_TAP + 850, 45500, wlP);
    }
    at(45700, st(560, 600), 0.4, true);
    if (wdr) {
      const chD = wdr.chart, endP = cd("workDone", chD.x + chD.w - 1, chD.y + chD.h * 0.33);
      at(47200, endP, 0.3, true); rest(47300, 49550, endP);
    }
    // 10: Team 3. Leads left to the sheet; taps into the field; steps aside while the job is typed; down to Continue
    // (pressed on 54000); up to wait beside the silhouette; then beside the large face, and beside the new name on Team.
    at(49700, st(520, 560), 0.4, true);
    const hrr = M.hire && M.hire.rects;
    if (hrr) {
      const tTy = evF("hire", "typeStart"), tSub = evF("hire", "submit"), inp = hrr.input, cb = hrr.characterBig, ch2 = hrr.character;
      const inP = cd("hire", inp.x + inp.w * 0.62, inp.y + inp.h * 0.62);
      at(tTy - 110, inP, 0.4, true); press(tTy - 70); at(tTy + 200, inP, 0);
      const sideP = cd("hire", inp.x + inp.w * 0.86, inp.y + inp.h * 0.8);
      at(tTy + 900, sideP, 0.5); at(tSub - 780, sideP, 0);
      const btnP = cd("hire", ...mid(hrr.submitBtn));
      at(tSub - 70, btnP, 0.6); press(tSub - 40); at(tSub + 130, btnP, 0);
      const waitP = cd("hire", ch2.x + ch2.w + 62, ch2.y + ch2.h * 0.7);
      at(T_ARRIVE - 250, waitP, 0.4, true); rest(T_ARRIVE - 200, T_SAYS_OUT - 300, waitP);
      const bigP = cd("hire", cb.x + cb.w + 34, cb.y + cb.h * 0.8);
      at(T_SAYS_OUT + 300, bigP, 0.3); at(T_TEAM_IN - 300, bigP, 0);
      const nn = hrr.newName, nameP = cd("hire", nn.x + nn.w + 150, nn.y + nn.h * 0.5);
      at(T_TEAM_IN + 480, nameP, 0.4, true); rest(T_TEAM_IN + 520, T_FLOWS - 1300, nameP);
    }
    // 11: Flows. Leads left (the Flows page comes from the left), waits beside the suggestion while it is read, taps
    // "Make it a flow" on 61800, rides into the flow, presses the switch on 63600, rests beside it.
    {
      const sug = rect("flow", "sug"), mk = rect("flow", "makeBtn"), sw = rect("flow", "switch");
      at(T_FLOWS - 1200, st(420, 600), 0.4, true);
      const besideP = cd("flow", Math.min(sug.x + sug.w - 30, mk.x + mk.w + 70), mk.y + mk.h + 34);
      at(T_FLOWS + 300, besideP, 0.3, true); at(T_FLOW_TAP - 500, besideP, 0);
      const mkP = cd("flow", mk.x + mk.w * 0.55, mk.y + mk.h * 0.6);
      at(T_FLOW_TAP - 70, mkP, 0.5); press(T_FLOW_TAP - 40); at(T_FLOW_TAP + 120, mkP, 0);
      const swP = cd("flow", sw.x + sw.w * 0.5, sw.y + sw.h * 0.6), swWait = cd("flow", sw.x + sw.w * 0.3 - 40, sw.y + sw.h + 46);
      at(T_FLOW_STEPS + 300, swWait, 0.5); at(T_FLOW_ON - 400, swWait, 0);
      at(T_FLOW_ON - 70, swP, 0.5); press(T_FLOW_ON - 40); at(T_FLOW_ON + 130, swP, 0);
      const restP = cd("flow", sw.x + sw.w * 0.3 - 30, sw.y + sw.h + 40);
      at(T_FLOW_ON + 600, restP, 0.4); rest(T_FLOW_ON + 650, T.pull - 900, restP);
    }
    // 9: flicks out ahead of the pull-back, then wanders over the wall (small), and flicks down to set off the fall.
    at(T.pull - 700, st(1180, 380), 0.5, true);
    // (first to the flow on the wall, beside its switch; then the new face on the Team page)
    { const sw = rect("flow", "switch"); at(T.pull + 600, wd(CARDS.flow.x + sw.x - 30, CARDS.flow.y + sw.y + sw.h + 40), 0.6, true); }
    at(T.pull + 1300, hrr && hrr.newFace ? wd(CARDS.hire.x + hrr.newFace.x + hrr.newFace.w + 60, CARDS.hire.y + hrr.newFace.y + hrr.newFace.h * 0.7) : wd(CARDS.hire.x + CW * 0.7, CARDS.hire.y + CH * 0.6), 0.5);
    at(T.pull + 2200, wd(CARDS.days.x + CW * 0.75, CARDS.days.y + CH * 0.3), 0.5);
    at(T.pull + 3100, wd(CARDS.watch.x + CW * 0.4, CARDS.watch.y + CH * 0.55), 0.5);
    at(T.pull + 3750, wd(CARDS.watch.x + CW * 0.45, CARDS.watch.y + CH * 0.5), 0.2);
    at(T.wallFall + 100, st(1040, 940), 0.3, true);
    // 10: waits just under the line, drags a selection across the phrase for each retype, then steps aside.
    const x0 = meas.left + meas.pre, pyWait = L2.y + 98, py = L2.y + 68;
    const re = SWAPS.map((x, i) => i).filter((i) => SWAPS[i].how === "retype");
    at(SWAPS[0].ft + 60, st(x0 - 10, pyWait), 0.6);
    re.forEach((i, j) => {
      const sw = SWAPS[i], wPrev = meas.ph[SWAPS[i - 1].phrase];
      at(sw.ft - 160, st(x0 - 8, pyWait), 0);
      at(sw.ft - L2.dragLead, st(x0 - 3, py), 0.3); press(sw.ft - 20, L2.drag);
      at(sw.ft + L2.drag, st(x0 + wPrev + 3, py), 0);
      at(sw.ft + L2.drag + 60, st(x0 + wPrev + 3, py), 0);
      if (j < re.length - 1) at(sw.ft + 380, st(x0 - 8, pyWait), 0.3);
    });
    const tAside = (re.length ? SWAPS[re[re.length - 1]].ft : SWAPS[0].ft) + 650;
    at(tAside, st(1560, 790), 0.6);
    // Drifts while the phrases flicker, never still.
    at(T.final - 3200, st(1610, 820), 0.5); at(T.final - 1200, st(1590, 860), 0.5); at(T.lift, st(1620, 880), 0.5);
    // 11: onto "Great", pressed on the final chord.
    at(T.great - 50, st(CK.great[0] + 4, CK.great[1] + 18), 0.5); press(T.great);
    at(T.great + 240, st(CK.great[0] + 4, CK.great[1] + 18), 0);
    at(T.great + 1000, st(Math.min(CK.great[0] + 150, 1700), Math.min(CK.great[1] + 130, 960)), 0.5);
    at(T.morph, st(Math.min(CK.great[0] + 160, 1710), Math.min(CK.great[1] + 136, 966)), 0);
    // 12: leaves as the circle becomes the orb.
    at(T.morph + 900, st(1780, 1200), 0.6, true);
    at(T.end + 1, st(1780, 1200), 0);
    for (let i = 1; i < k.length; i++) if (k[i].t <= k[i - 1].t) k[i].t = k[i - 1].t + 1;
    PTR = k; PRESS = pr;
  }
  function pointerPos(t) {
    let i = 0;
    while (i < PTR.length - 2 && t >= PTR[i + 1].t) i++;
    const a = PTR[i], b = PTR[i + 1];
    const p = inOut(prog(t, a.t, b.t));
    // On a lead key the start is frozen where the pointer set off,
    // and the end aims at where its target will be on arrival, sliding onto the live target only at the very end
    // (so it never chases a target that is still off frame).
    const A = b.lead ? a.pos(a.t) : a.pos(t);
    let B = b.pos(t);
    if (b.lead) { const Bf = b.pos(b.t), w = p * p * p; B = [lerp(Bf[0], B[0], w), lerp(Bf[1], B[1], w)]; }
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const bow = 0.13 * b.bend * Math.sin(Math.PI * p) * (dx >= 0 ? 1 : -1);
    let x = lerp(A[0], B[0], p) - dy * bow, y = lerp(A[1], B[1], p) + dx * bow;
    x += 2.2 * Math.sin(t / 830); y += 2.2 * Math.cos(t / 1010);
    return [x, y];
  }
  function pointerAt(t) {
    const [x, y] = pointerPos(t);
    const [x0, y0] = pointerPos(t - FRAME / 2);
    const v = 2 * Math.hypot(x - x0, y - y0); // px per frame
    let down = 0, ripple = null;
    for (const pr of PRESS) {
      const e = t < pr.t ? prog(t, pr.t - 110, pr.t) : 1 - prog(t, pr.t + pr.hold, pr.t + pr.hold + 240);
      down = Math.max(down, inOutSoft(e));
      if (t >= pr.t && t < pr.t + pr.ripple) ripple = (t - pr.t) / 520;
    }
    const small = lerp(1, 0.72, inOut(prog(t, T.pull - 300, T.pull + 700)) * (1 - inOut(prog(t, T.wallFall, T.wallFall + 700))));
    // Stretch along fast travel.
    const stretch = 1 + Math.min(v, 140) / 400;
    return { x, y, scale: small * (1 - 0.2 * down), base: small, ripple, v, angle: Math.atan2(y - y0, x - x0), stretch };
  }

  // ---------- DOM ----------
  const cardEls = {};
  function build() {
    const world = $("world");
    for (const n of Object.keys(CARDS)) {
      const el = document.createElement("div"); el.className = "card";
      const mk = (parent) => { const i = document.createElement("img"); i.alt = ""; i.decoding = "sync"; parent.appendChild(i); return { img: i, src: null }; };
      const A = mk(el), B = mk(el);
      const flyEl = document.createElement("div"); flyEl.className = "card__fly"; el.appendChild(flyEl);
      const F = mk(flyEl), G = mk(flyEl);
      const slotEl = document.createElement("i"); slotEl.className = "card__slot"; el.insertBefore(slotEl, flyEl);
      const fillEl = document.createElement("i"); fillEl.className = "card__slot"; el.insertBefore(fillEl, slotEl);
      const patchEl = document.createElement("i"); patchEl.className = "card__slot"; el.insertBefore(patchEl, B.img);
      let cover = null;
      if (n === "home") {
        cover = document.createElement("div"); cover.className = "card__cover";
        cover.innerHTML = ICON(ICONS[0]);
        el.appendChild(cover);
      }
      world.appendChild(el);
      cardEls[n] = { el, A, B, F, G, flyEl, slotEl, fillEl, patchEl, cover };
    }
    const tiles = $("tiles");
    ICONS.forEach((ic) => { const d = document.createElement("div"); d.className = "tile"; d.innerHTML = ICON(ic); tiles.appendChild(d); });
    $("line1").innerHTML = LINE1.map((w, i) => `<span class="w">${w}${i < LINE1.length - 1 ? " " : ""}</span>`).join("");
  }

  // ---------- screen images ----------
  const bad = new Set();
  const pad4 = (n) => String(n).padStart(4, "0");
  const frameOf = (name, cap) => { const n = M[name].frames; return clamp(Math.floor((cap * FPS) / 1000 + 1e-6), 0, n - 1); };
  // -> { a: [urls], b: [urls] | null, mix, clip: {x,y,w,h,r} | null, fly: {...} | null }
  // `ct` is the capture clock: which app frame shows (render.cjs holds it at the output frame's time for every blur
  // sub-sample); `t` drives everything that moves (morph geometry).
  function sources(name, t, ct = t) {
    const look = `${CFG.look}/${LOOK[name] || name}.png`;
    const c = CARDS[name];
    const m = c.shot ? M[name] : null;
    if (WALL_STILL[name] && t >= T_WALL_STILL) return { a: [`${CFG.cap}/stills/${WALL_STILL[name]}.jpg`, look], b: null, mix: 0 };
    if (!m || !m.frames) return { a: [`${CFG.cap}/stills/${STILL[name] || name}.jpg`, look], b: null, mix: 0 };
    const n = m.frames;
    const url = (k) => [`${CFG.cap}/${name}/${pad4(k)}.jpg`, look];
    const local = ct - SHOT_START[name];
    let i;
    if (name === "graph" && n > 1) {
      // Ping-pong, so the nodes keep moving however long the pull-back lasts.
      i = Math.floor((Math.max(0, local) * FPS) / 1000);
      const span = 2 * (n - 1); i = ((i % span) + span) % span; if (i > n - 1) i = span - i;
    } else i = frameOf(name, capTime(name, local));
    // A fly morph rides over the frames (and over a grow).
    let fly = null;
    for (const g of MORPH[name] || []) {
      if (g.kind === "wipe" && t >= g.at - 1 && t < g.at + g.dur) {
        const e = inOutSoft(prog(t, g.at, g.at + g.dur)), r = { x: g.rect.x + g.rect.w * e, y: g.rect.y, w: g.rect.w * (1 - e), h: g.rect.h };
        fly = { src: url(frameOf(name, g.capA)), from: r, to: r, r, e: 0, o: 1, srcB: null, mixB: 0, slot: null, cover: null, radius: 0 };
        continue;
      }
      const d0 = g.delay || 0; // it sits on its start rect until it lifts off
      // (`onCap`: the page under it is swapped by the capture clock, which every blur sub-sample of a frame shares; so
      // the crop and its slot are on for the whole of the swap's frame, not only the sub-samples after the swap)
      if (g.kind !== "fly" || (g.onCap ? Math.max(t, ct) : t) < g.at - 1 || t >= g.at + d0 + g.dur + 160) continue;
      const p = prog(t, g.at + d0, g.at + d0 + g.dur), e = g.ride ? lopP(p, 0.35) : g.ease === "outCubic" ? outCubic(p) : lopP(p, g.ease || 0.3);
      // The size moves a touch ahead of the position, so the thing reads as lifting off and settling in (riding, it keeps
      // its top-left on the banner it becomes).
      const es = g.ease === "outCubic" ? e : lopP(p, 0.22);
      // Riding on a carried grow: the target travels with the page it lands on.
      const sh = g.ride ? growShift(g.ride, t) : [0, 0];
      const r = g.ride
        ? { x: g.to.x + sh[0], y: g.to.y + sh[1], w: lerp(g.from.w, g.to.w, es), h: lerp(g.from.h, g.to.h, es) }
        : { x: lerp(g.from.x, g.to.x, e), y: lerp(g.from.y, g.to.y, e), w: lerp(g.from.w, g.to.w, es), h: lerp(g.from.h, g.to.h, es) };
      // Each end is a crop of its own frame, fitted to the travelling rect (cover, never stretched); the far end's crop
      // fades in over the middle of the flight.
      fly = { src: url(frameOf(name, g.capA)), from: g.srcRect || g.from, to: g.to, r, e: g.hold ? 0 : e, o: g.hold ? (p < 1 ? 1 : 0) : 1 - prog(t, g.at + d0 + g.dur, g.at + d0 + g.dur + 160),
        srcB: g.capB !== undefined ? url(frameOf(name, g.capB)) : null, mixB: inOutSoft(prog(p, ...(g.mixAt || [0.25, 0.8]))), slot: p < 1 ? g.slot : null, cover: g.cover ? g.cover(p) : null,
        // the slot belongs to the new page: it fades in with it
        slotO: g.slotIn ? inOutSoft(prog(t, g.at + g.slotIn[0], g.at + g.slotIn[1])) : 1 };
    }
    // A carried scroll: frame capA and frame capB (S further down the page) as one page, scrolled by S. Both are clipped
    // above the fixed nav, which is drawn once, still, from capA (on the fly layer).
    for (const g of MORPH[name] || []) {
      if (g.kind !== "scroll" || t < g.at - 1 || t >= g.at + g.dur) continue;
      const e = scrollE(g, t), navR = { x: 0, y: g.nav, w: CW, h: CH - g.nav };
      const still = { src: url(frameOf(name, g.capA)), from: navR, to: navR, r: navR, e: 0, o: 1, srcB: null, mixB: 0, slot: null, radius: 0 };
      return { a: url(frameOf(name, g.capA)), b: url(frameOf(name, g.capB)), mix: 1, shiftA: [0, -g.S * e], shift: [0, g.S * (1 - e)],
        clipA: { bottom: CH - g.nav }, clip: { x: 0, y: 0, w: CW, h: g.nav, r: 0 }, fly: still };
    }
    // A grow morph: the frame before the tap, and the opened view revealed through a growing rounded clip.
    for (const g of MORPH[name] || []) {
      // (from 1 ms early: on the tap's own frame the capture already shows the app's route change)
      if (t < g.at - 1 || t >= g.at + g.dur) continue;
      // A plain grow pops open (outExpo); a carried one (fromB) moves on the camera's own lopsided curve, so the card
      // and the camera travel together.
      const gp = prog(t, g.at, g.at + g.dur);
      const e = g.kind !== "grow" ? 0 : g.fromB || g.ease === "lop" ? lopP(gp, 0.35) : outExpo(gp);
      if (g.kind === "grow") {
        const f0 = g.fromB || g.from;
        // (the clip starts on fromB in the new view's own coordinates)
        const r = { x: lerp(f0.x, g.to.x, e), y: lerp(f0.y, g.to.y, e), w: lerp(f0.w, g.to.w, e), h: lerp(f0.h, g.to.h, e) };
        const shift = g.fromB ? growShift(g, t) : null;
        const capB = g.live ? Math.max(g.capB, capTime(name, local)) : g.capB;
        // Options: xfade [ms, ms] after the tap over which the new view fades in inside the clip (the old one held
        // until then, so nothing swaps on one frame); fadeA [p, p] the old page fading out beneath (no stacked pages);
        // fill {color, from, to}: the clip starts filled with the tapped thing's own colour and clears to the new view.
        const mix = g.xfade ? inOutSoft(prog(t, g.at + g.xfade[0], g.at + g.xfade[1])) : 1;
        const aO = g.fadeA ? 1 - inOutSoft(prog(gp, g.fadeA[0], g.fadeA[1])) : 1;
        const fill = g.fill ? { color: g.fill.color, o: 1 - inOutSoft(prog(gp, g.fill.from, g.fill.to)) } : null;
        const patch = g.patch ? { rect: g.patch.rect, color: g.patch.color, o: inOutSoft(prog(t, g.at + g.patch.ms[0], g.at + g.patch.ms[1])) } : null;
        return { a: url(frameOf(name, g.capA)), b: url(frameOf(name, capB)), mix, aO, fill, patch, clip: Object.assign(r, { r: lerp(18, g.to.w >= CW - 1 ? 44 : 22, e) }), shift, fly };
      }
    }
    // Capture frames to hide (the app re-rendering a list, say): <shot>.covers = [{from, to}] (or one <shot>.cover);
    // those frames show a cross-blend from frame from-1 to frame to+1 instead.
    for (const h of m.covers || (m.cover ? [m.cover] : [])) {
      if (typeof h.from === "number" && typeof h.to === "number" && i >= h.from && i <= h.to && h.from > 0 && h.to < n - 1) {
        // Never a blend of two layouts: the frame before the re-render, then on the middle frame the one after.
        return { a: url(i - h.from < (h.to - h.from + 1) / 2 ? h.from - 1 : h.to + 1), b: null, mix: 0, fly };
      }
    }
    return { a: url(i), b: null, mix: 0, fly };
  }
  const scrollE = (g, t) => lopP(prog(t, g.at, g.at + g.dur), 0.42);
  function growShift(g, t) {
    if (!g.fromB) return [0, 0];
    if (g.shiftFn) return g.shiftFn(t);
    const e = lopP(prog(t, g.at, g.at + g.dur), 0.35);
    const s0 = g.shift0 || [g.from.x - g.fromB.x, g.from.y - g.fromB.y];
    return [s0[0] * (1 - e), s0[1] * (1 - e)];
  }
  async function setImage(layer, cands) {
    for (const u of cands) {
      if (bad.has(u)) continue;
      if (layer.src === u) return;
      try { layer.img.src = u; await layer.img.decode(); layer.src = u; return; } catch (e) { bad.add(u); layer.src = null; }
    }
  }
  async function probeScale(name, url) {
    try { const im = new Image(); im.src = url; await im.decode(); ZMAX[name] = 1.25 * (im.naturalWidth / CW); } catch (e) { /* default */ }
  }

  // ---------- draw ----------
  const tf = (el, s) => { el.style.transform = s; };
  const show = (el, o) => { el.style.opacity = o <= 0.001 ? "0" : o >= 0.999 ? "1" : o.toFixed(4); el.style.visibility = o <= 0.001 ? "hidden" : "visible"; };
  // The wall's fall: column by column (70 ms apart), each card over 600 ms.
  const fallStart = (c) => T.wallFall + c.col * 70 + c.row * 35;
  const FALL = 1500; // world units
  function wallFallSpeed(t) {
    const z = cameraAt(t).z;
    let best = 0;
    for (const n of Object.keys(CARDS)) {
      const f0 = fallStart(CARDS[n]);
      const a = inCubic(prog(t, f0, f0 + 600)), b = inCubic(prog(t + FRAME, f0, f0 + 600));
      if (a < 0.98) best = Math.max(best, (b - a) * FALL * z);
    }
    return best;
  }

  function draw(t, ct = t) {
    const jobs = [];
    const cam = cameraAt(t);

    // Aurora: a slow drift, as in base.css.
    const da = Math.sin(t / 8200), db = Math.sin(t / 10100 + 1.3);
    tf($("aurA"), `translate(${(150 * da).toFixed(2)}px, ${(70 * da).toFixed(2)}px) scale(${(1.06 + 0.06 * da).toFixed(4)})`);
    tf($("aurB"), `translate(${(-170 * db).toFixed(2)}px, ${(50 * db).toFixed(2)}px) scale(${(0.98 - 0.05 * db).toFixed(4)})`);

    // Wall.
    const diveQ = inOut(prog(t, T.dive + 60, T.dive + 1300));
    for (const n of Object.keys(CARDS)) {
      const c = CARDS[n], d = cardEls[n];
      // The neighbours fade in as the dive lands (they are off frame by then).
      let o = n === "home" ? (t >= T.dive ? 1 : 0) : prog(t, 8800, 9400);
      // The hire sheet's neighbours are away while the camera is on it (faded while off frame), back for the wall.
      // (Flows, the next card left, comes back as the camera sets off for it)
      if (HIDE_BY_FLOW.has(n)) o *= 1 - inOutSoft(prog(t, T_FLOWS + 700, T_FLOWS + 1000)) * (1 - inOutSoft(prog(t, T.pull - 600, T.pull - 420)));
      if (HIDE_BY_HIRE.has(n)) o *= 1 - inOutSoft(prog(t, 51700, 52000)) * (1 - inOutSoft(n === "flow" ? prog(t, T_FLOWS - 650, T_FLOWS - 500) : prog(t, T.pull - 600, T.pull - 420)));
      const f0 = fallStart(c);
      const fp = prog(t, f0, f0 + 600);
      const fall = inCubic(fp) * FALL;
      o *= 1 - inOutSoft(prog(fp, 0.35, 1));
      // The Home card starts as tile 1 (a square window with the tile's icon) and opens out.
      let inset = 0, radius = 44;
      if (n === "home" && t < T.home) {
        inset = ((CH - CW) / 2) * (1 - diveQ);
        radius = lerp((TILE.radius * CW) / TILE.size, 44, diveQ);
        const co = 1 - inOutSoft(prog(t, T.dive + 100, T.dive + 700));
        show(d.cover, co);
        d.cover.firstChild.style.width = d.cover.firstChild.style.height = ((TILE.icon * CW) / TILE.size).toFixed(1) + "px";
      } else if (d.cover) show(d.cover, 0);
      const rot = fp > 0 ? inCubic(fp) * (c.col % 2 ? 5 : -4) : 0;
      const [px, py] = project(cam, c.x, c.y + inset + fall);
      const w = CW * cam.z, h = (CH - 2 * inset) * cam.z;
      const vis = o > 0.001 && px < W + 80 && px + w > -80 && py < H + 80 && py + h > -80;
      show(d.el, vis ? o : 0);
      if (!vis) continue;
      d.el.style.height = (CH - 2 * inset).toFixed(2) + "px";
      d.el.style.borderRadius = radius.toFixed(2) + "px";
      d.A.img.style.top = d.B.img.style.top = (-inset).toFixed(2) + "px";
      tf(d.el, `translate(${px.toFixed(3)}px, ${py.toFixed(3)}px) scale(${cam.z.toFixed(5)}) rotate(${rot.toFixed(3)}deg)`);
      const src = sources(n, t, ct);
      jobs.push(setImage(d.A, src.a));
      d.B.img.style.opacity = src.b ? src.mix.toFixed(4) : "0";
      d.A.img.style.opacity = src.aO !== undefined ? src.aO.toFixed(4) : "1";
      d.A.img.style.transform = src.shiftA ? `translate(${src.shiftA[0].toFixed(3)}px, ${src.shiftA[1].toFixed(3)}px)` : "none";
      d.A.img.style.clipPath = src.clipA ? `inset(0px 0px ${src.clipA.bottom}px 0px)` : "none";
      if (src.fill && src.clip && src.fill.o > 0.001) {
        const r = src.clip, sh = src.shift || [0, 0];
        show(d.fillEl, src.fill.o);
        Object.assign(d.fillEl.style, { left: (r.x + sh[0]).toFixed(2) + "px", top: (r.y + sh[1] - inset).toFixed(2) + "px", width: r.w.toFixed(2) + "px", height: r.h.toFixed(2) + "px", borderRadius: r.r.toFixed(1) + "px", background: src.fill.color });
      } else show(d.fillEl, 0);
      const pat = src.patch || (src.fly && src.fly.cover);
      if (pat && pat.o > 0.001) {
        const r = pat.rect;
        show(d.patchEl, pat.o);
        Object.assign(d.patchEl.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px", borderRadius: pat.radius || "16px", background: pat.color });
      } else show(d.patchEl, 0);
      if (src.b) jobs.push(setImage(d.B, src.b));
      d.B.img.style.transform = src.shift ? `translate(${src.shift[0].toFixed(3)}px, ${src.shift[1].toFixed(3)}px)` : "none";
      if (src.clip) {
        const r = src.clip;
        d.B.img.style.clipPath = `inset(${r.y.toFixed(2)}px ${(CW - r.x - r.w).toFixed(2)}px ${(CH - r.y - r.h).toFixed(2)}px ${r.x.toFixed(2)}px round ${r.r.toFixed(1)}px)`;
      } else d.B.img.style.clipPath = "none";
      if (src.fly) {
        const f = src.fly;
        show(d.flyEl, f.o);
        d.flyEl.style.width = f.r.w.toFixed(3) + "px"; d.flyEl.style.height = f.r.h.toFixed(3) + "px";
        d.flyEl.style.borderRadius = (f.radius !== undefined ? f.radius : 8) + "px";
        const lift = Math.sin(Math.PI * f.e);
        d.flyEl.style.boxShadow = `0 ${(4 + 10 * lift).toFixed(1)}px ${(10 + 26 * lift).toFixed(1)}px -8px oklch(0.3 0.05 264 / ${(0.4 * lift).toFixed(3)})`;
        tf(d.flyEl, `translate(${f.r.x.toFixed(3)}px, ${f.r.y.toFixed(3)}px)`);
        // Cover-fit the crop `c` of a 390x844 frame into the rect.
        const fit = (img, c) => {
          const k = Math.max(f.r.w / c.w, f.r.h / c.h);
          // (by transform, not by layout size: a resized image is re-rastered late and blur sub-samples came back stale)
          img.style.left = img.style.top = "0px"; img.style.transformOrigin = "0 0";
          img.style.transform = `translate(${(f.r.w / 2 - (c.x + c.w / 2) * k).toFixed(3)}px, ${(f.r.h / 2 - (c.y + c.h / 2) * k).toFixed(3)}px) scale(${k.toFixed(5)})`;
        };
        if (f.slot) {
          // The slot belongs to the new page: only where that page shows (inside a grow's opening, if one is running).
          let sr = { x: f.to.x, y: f.to.y, w: f.to.w, h: f.to.h };
          if (src.clip && src.b) {
            const c = src.clip, sh = src.shift || [0, 0], x0 = Math.max(sr.x, c.x + sh[0]), y0 = Math.max(sr.y, c.y + sh[1]);
            const x1 = Math.min(sr.x + sr.w, c.x + sh[0] + c.w), y1 = Math.min(sr.y + sr.h, c.y + sh[1] + c.h);
            sr = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
          }
          show(d.slotEl, sr.w > 0.5 && sr.h > 0.5 ? f.slotO : 0);
          Object.assign(d.slotEl.style, f.slot, { left: sr.x + "px", top: sr.y + "px", width: sr.w + "px", height: sr.h + "px" });
        } else show(d.slotEl, 0);
        fit(d.F.img, f.from);
        jobs.push(setImage(d.F, f.src));
        if (f.srcB && f.mixB > 0.001) {
          fit(d.G.img, f.to); d.G.img.style.opacity = f.mixB.toFixed(4);
          jobs.push(setImage(d.G, f.srcB));
        } else d.G.img.style.opacity = "0";
      } else { show(d.flyEl, 0); show(d.slotEl, 0); }
    }

    // 1-3: the opening, locked to the world.
    const ox = openXf(cam);
    tf($("open"), `translate(${ox.tx.toFixed(3)}px, ${ox.ty.toFixed(3)}px) scale(${ox.k.toFixed(5)})`);
    show($("open"), t < T.dive + 1600 ? 1 : 0);
    const orbIn = outExpo(prog(t, T.orbPop, T.orbPop + 620));
    // The opening stays opaque through the dive (the zoom flings it out of frame) and only fades over 7900-8100.
    const diveFade = inOutSoft(prog(t, 7900, 8100));
    const orbOut = inCubic(prog(t, T.dive, T.dive + 900));
    const squeeze = 1 - 0.07 * Math.sin(Math.PI * prog(t, T.orbPress - 60, T.orbPress + 320));
    const breathe = 1 + 0.012 * Math.sin(t / 900);
    const orb1 = $("orb1");
    show(orb1, t >= T.orbPop && diveFade < 1 ? 1 - diveFade : 0);
    tf(orb1, `translate(${ORB1.x}px, ${ORB1.y - orbOut * 60}px) scale(${(orbIn * (1 - 0.4 * orbOut) * squeeze * breathe).toFixed(4)})`);
    tf(orb1.firstElementChild, `rotate(${((t / 11000) * 360).toFixed(2)}deg)`);

    const n = tileCount(t);
    const tiles = $("tiles").children;
    for (let i = 0; i < 8; i++) {
      const pop = outExpo(prog(t, tileT(i), tileT(i) + 420));
      // Tiles fall during the dive, the far ones first-ish, the ones beside tile 1 last.
      const f0 = T.dive + 60 + (7 - i) * 22;
      const fp = prog(t, f0, f0 + 900);
      const gone = i === 0 ? t >= T.dive + 30 : fp >= 1;
      show(tiles[i], t >= tileT(i) && !gone ? 1 - diveFade : 0);
      const tap = 1 - 0.05 * Math.sin(Math.PI * prog(t, T.dive - 110, T.dive + 60)) * (i === 0 ? 1 : 0);
      tf(tiles[i], `translate(${tileX(i, n).toFixed(2)}px, ${(TILE.y + inCubic(fp) * 380).toFixed(2)}px) rotate(${(inCubic(fp) * (i % 2 ? 9 : -8)).toFixed(2)}deg) scale(${(pop * tap).toFixed(4)})`);
    }

    const l1 = $("line1"), words = l1.children;
    show(l1, t >= T.line1 && t < T.dive + 900 ? 1 : 0);
    tf(l1, `translate(0px, ${LINE1_Y - 44}px)`);
    for (let i = 0; i < words.length; i++) {
      const a = outExpo(prog(t, T.line1 + i * 300, T.line1 + i * 300 + 300));
      const fp = prog(t, T.dive + 30 + i * 30, T.dive + 30 + i * 30 + 900);
      words[i].style.opacity = (a * (1 - diveFade)).toFixed(4);
      tf(words[i], `translate(0px, ${((1 - a) * 22 + inCubic(fp) * 260).toFixed(2)}px)`);
    }

    // 10-11: the closing line, its swaps, and the lift (line and card on one curve, the card 150 ms behind).
    const s = line2State(t), l2 = $("line2");
    const lift = lopP(prog(t, T.lift, T.lifted), 0.35);
    const rise = lopP(prog(t, T.lift + 150, T.lifted + 150), 0.35);
    // Line and card fall away (down 80, to 96%, inCubic) as the circle leaves them to become the orb.
    const go = inCubic(prog(t, T.morph + 100, T.morph + 520));
    show(l2, s && go < 1 ? 1 - go : 0);
    if (s) {
      const key = s.pre + "|" + s.sel + "|" + s.rest;
      if (l2._k !== key) { $("l2a").textContent = s.pre; $("l2sel").textContent = s.sel; $("l2b").textContent = s.rest; l2._k = key; }
      const stl = outExpo(clamp(s.settle / (s.settleDur || 80)));
      tf($("l2b"), `translate(0px, ${((1 - stl) * 10).toFixed(2)}px)`);
      $("l2b").style.opacity = lerp(0.35, 1, stl).toFixed(3);
      const sc = lerp(1, L2.liftScale, lift);
      const liftLeft = W / 2 - (L2.liftScale * (meas.pre + meas.ph[SWAPS[SWAPS.length - 1].phrase])) / 2;
      const x = lerp(meas.left, liftLeft, lift);
      const y = lerp(L2.y, L2.liftY, lift) + go * 80;
      l2.style.transformOrigin = "0 50%";
      tf(l2, `translate(${x.toFixed(2)}px, ${(y - 50).toFixed(2)}px) scale(${(sc * (1 - 0.04 * go)).toFixed(4)})`);
      $("caret").style.opacity = s.caret && (s.typing || Math.floor((t / BEAT) * 2) % 2 === 0) ? "1" : "0";
    }

    // The check-in card rises in beneath the line.
    const ck = $("checkin");
    const ckOn = t >= T.lift + 150 && go < 1;
    show(ck, ckOn ? 1 - go : 0);
    if (ckOn) {
      const kick = 1 - 0.012 * Math.sin(Math.PI * prog(t, T.great - 60, T.great + 300));
      const sc = CK.scale * kick * (1 - 0.04 * go);
      const topY = CK.cy - (CK.h * CK.scale) / 2;
      const y = topY + (1 - rise) * (H - topY + 40) + go * 80 - (CK.great[1] - topY) * (kick - 1) + (CK.h * CK.scale * 0.02) * go;
      tf(ck, `translate(${(CK.cx - (CK.w * sc) / 2).toFixed(2)}px, ${y.toFixed(2)}px) scale(${sc.toFixed(5)})`);
      jobs.push(setImage(CK.layer, checkinSources(ct)));
      CK.hole.style.opacity = t >= T.morph ? "1" : "0";
    }

    // 12: the pressed Great circle leaves the card and becomes the orb; the wordmark forms beside it.
    const lockLeft = W / 2 - (LOCK.orb + LOCK.gap + meas.word) / 2;
    const orbC = [lockLeft + LOCK.orb / 2, H / 2];
    const mp = prog(t, T.morph, T.morph + 900);
    const me = lopP(mp, 0.3);
    const gf = $("greatfly");
    if (t >= T.morph && mp < 1) {
      // Starts exactly where the circle sits on the landed card.
      const d0 = CK.circ.w * CK.scale;
      const c0 = CK.toScreen(CK.circ.x + CK.circ.w / 2, CK.circ.y + CK.circ.h / 2);
      const d = lerp(d0, LOCK.orb, me);
      const cx = lerp(c0[0], orbC[0], me), cyy = lerp(c0[1], orbC[1], me) - Math.sin(Math.PI * me) * 60;
      show(gf, 1 - inOutSoft(prog(mp, 0.42, 0.6)));
      gf.style.width = gf.style.height = CK.circ.w + "px";
      const im = CK.fly.img;
      im.style.width = CW + "px"; im.style.height = CH + "px";
      im.style.left = -CK.circ.x + "px"; im.style.top = -CK.circ.y + "px";
      tf(gf, `translate(${(cx - d / 2).toFixed(2)}px, ${(cyy - d / 2).toFixed(2)}px) scale(${(d / CK.circ.w).toFixed(5)})`);
      jobs.push(setImage(CK.fly, checkinSources(T.morph)));
    } else show(gf, 0);
    const lk = $("lockup"), orb2 = $("orb2"), wm = $("wordmark");
    show(lk, t >= T.morph ? 1 : 0);
    if (t >= T.morph) {
      // The orb takes over from the circle mid-flight, at the circle's size and place.
      const d0 = CK.circ.w * CK.scale;
      const c0 = CK.toScreen(CK.circ.x + CK.circ.w / 2, CK.circ.y + CK.circ.h / 2);
      const d = lerp(d0, LOCK.orb, me);
      const cx = lerp(c0[0], orbC[0], me), cyy = lerp(c0[1], orbC[1], me) - Math.sin(Math.PI * me) * 60;
      const settle = 1 + 0.06 * Math.sin(Math.PI * prog(t, T.morph + 820, T.morph + 1300));
      show(orb2, inOutSoft(prog(mp, 0.18, 0.45)));
      tf(orb2, `translate(${cx.toFixed(2)}px, ${cyy.toFixed(2)}px) scale(${((d / LOCK.orb) * settle * (1 + 0.012 * Math.sin(t / 900))).toFixed(4)})`);
      tf(orb2.firstElementChild, `rotate(${((t / 11000) * 360).toFixed(2)}deg)`);
      // From 60000 (the card is gone by then) the wordmark slides out from behind the orb: clipped at the orb's right
      // edge, so nothing of it shows over or beside the card; the orb is drawn above it (film.css).
      const wi = outExpo(prog(t, T.morph + 600, T.morph + 1150));
      const wmX = lockLeft + LOCK.orb + LOCK.gap - (1 - wi) * (meas.word * 0.7 + LOCK.gap);
      const orbRight = cx + (d / 2) * settle;
      wm.style.opacity = t >= T.morph + 600 ? "1" : "0";
      wm.style.clipPath = `inset(-20px -40px -40px ${Math.max(-20, orbRight - wmX).toFixed(2)}px)`;
      tf(wm, `translate(${wmX.toFixed(2)}px, ${H / 2 - 95 - 7}px)`);
    }

    // Fade to bare canvas over the last 300 ms.
    $("content").style.opacity = (1 - inOutSoft(prog(t, T.fade, T.end - FRAME))).toFixed(4);

    // Pointer: stretched along its travel when fast.
    const p = pointerAt(t);
    const ang = (p.angle * 180) / Math.PI;
    tf($("pointer"), `translate(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px) rotate(${ang.toFixed(2)}deg) scale(${(p.scale * p.stretch).toFixed(4)}, ${(p.scale / Math.sqrt(p.stretch)).toFixed(4)})`);
    show($("pointer"), 1 - prog(t, T.fade, T.end - FRAME));
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
    await Promise.all([...SHOTS].filter((n) => M[n] && M[n].frames).map((n) => probeScale(n, `${CFG.cap}/${n}/0000.jpg`)));
    measure();
    buildMaps();
    buildMorphs();
    buildCheckin();
    buildCamera();
    buildPointer();
  })();

  window.seek = async (ms, opts = {}) => {
    await ready;
    await Promise.all(draw(ms, typeof opts.capMs === "number" ? opts.capMs : ms));
  };
  window.camSpeed = async (ms) => { await ready; return camSpeed(ms); };
  // More blur samples where something flies across a card while the camera moves (the new face into the Team page
  // during the pull-back): render.cjs multiplies its sample count by this.
  window.blurBoost = async (ms) => { await ready; return (ms >= T_SAYS_OUT && ms < T_SAYS_OUT + 320) || (ms >= T_TEAM_IN && ms < T_TEAM_IN + 480) ? 4 : 1; };
  // The moves, their fastest frame (ms) and peak speed (px/frame), for the sound (motion-peaks.json).
  window.filmPeaks = async () => {
    await ready;
    const out = [];
    for (const m of MOVES) {
      if (!m.label) continue;
      // A hard cut: no travel, no whoosh; its time is the first frame after it.
      if (m.cut) { const ms = Math.ceil(m.s / FRAME) * FRAME; out.push({ label: m.label, name: m.label, cut: true, ms: Math.round(ms), at: Math.round(ms), frame: Math.round(ms / FRAME), pxPerFrame: 0, start: Math.round(ms), end: Math.round(ms) }); continue; }
      let best = -1, bt = m.s;
      // Within 250 ms of the move's own fastest moment (s + a), so an overlapping later move cannot claim its peak.
      for (let f = Math.floor((m.s + m.a - Math.min(250, m.a * 0.5)) / FRAME); f * FRAME <= m.s + m.a + Math.min(250, m.b * 0.3); f++) { const v = camSpeed(f * FRAME); if (v > best) { best = v; bt = f * FRAME; } }
      out.push({ label: m.label, name: m.label, ms: Math.round(bt), at: Math.round(bt), frame: Math.round(bt / FRAME), pxPerFrame: +best.toFixed(1), start: Math.round(m.s), end: Math.round(m.s + m.a + m.b) });
    }
    // Two moves the camera does not make: the check-in card rising (line and card on one curve) and the circle flying to the orb.
    const card = H * 0.62 * (2 / 0.6) * FRAME / 1000; // rise distance over 600 ms at the lopsided peak, px/frame
    out.push({ label: "finale-card", name: "finale-card", ms: Math.round(T.lift + 150 + 0.35 * 600), at: Math.round(T.lift + 150 + 0.35 * 600), frame: Math.round((T.lift + 360) / FRAME), pxPerFrame: +card.toFixed(1), start: T.lift + 150, end: T.lifted + 150 });
    out.push({ label: "orb-morph", name: "orb-morph", ms: Math.round(T.morph + 0.3 * 900), at: Math.round(T.morph + 0.3 * 900), frame: Math.round((T.morph + 270) / FRAME), pxPerFrame: 30, start: T.morph, end: T.morph + 900 });
    return out;
  };
  // Film time (ms) of every capture event as film.js plays it, pointer presses, and the finale beats (for cues.py).
  window.filmEvents = async () => {
    await ready;
    const o = {};
    for (const shot of ["home", "ask", "saved", "track", "music", "habits", "work", "workDone", "hire", "flow"]) {
      const names = Object.keys(Object.assign({}, FALLBACK_EVENTS[shot], (M[shot] || {}).events));
      for (const e of names) { const v = evF(shot, e); if (v !== null && (hasEv(shot, e) || !M[shot])) o[shot + "." + e] = Math.round(v); }
    }
    for (const [shot, list] of Object.entries(MORPH)) list.forEach((g, i) => { o[`morph.${shot}.${g.kind}${i ? i : ""}`] = Math.round(g.at); o[`morph.${shot}.${g.kind}${i ? i : ""}.end`] = Math.round(g.at + (g.delay || 0) + g.dur); });
    o["checkin.press"] = T.great; o["finale.lift"] = T.lift; o["finale.cardRise"] = T.lift + 150; o["finale.morph"] = T.morph; o["finale.wordmark"] = T.word; o["finale.fade"] = T.fade;
    o["wall.fallStart"] = T.wallFall; o["line2.typeStart"] = T.line2;
    // Team 2 and 3 as played. `work.*`: the chips wholly in frame, the working line, the step down and the reached line
    // (shot workDone); `hire.arrive` is the new face on 55200, `hire.hello` / `hire.says` its two lines,
    // `hire.joined` "... is on your team", `hire.faces` the Team page with the face landed. `cut.work`: the hard cut.
    for (const k of Object.keys(o)) if (/^(work\.(finish|done)|hire\.(skip|addShown|plan|add|done|scrollStart|scrollEnd|faces|dayHello|joined))$/.test(k)) delete o[k];
    if (hasEv("workDone", "reached")) { o["work.stepDown"] = o["work.result"] = o["work.reached"] = Math.round(evF("workDone", "reached")); }
    if (hasEv("hire", "joined")) { o["hire.arrive"] = T_ARRIVE; o["hire.joined"] = T_SAYS_OUT; o["hire.faces"] = T_TEAM_IN + 300; }
    o["cut.work"] = T_HABITS_CUT;
    o["flows.suggest"] = T_FLOWS; o["flows.make"] = T_FLOW_TAP; o["flows.steps"] = T_FLOW_STEPS; o["flows.on"] = T_FLOW_ON;
    const ch = M.work && M.work.rects && M.work.rects.chips;
    if (ch) for (let f = Math.floor(42600 / FRAME); f * FRAME < 45000; f++) {
      const cam = cameraAt(f * FRAME), [x0, y0] = project(cam, CARDS.work.x + ch.x, CARDS.work.y + ch.y), [x1, y1] = project(cam, CARDS.work.x + Math.min(CW, ch.x + ch.w), CARDS.work.y + ch.y + ch.h);
      if (x0 >= 0 && y0 >= 0 && x1 <= W && y1 <= H) { o["work.chips"] = Math.round(f * FRAME); break; }
    }
    PRESS.forEach((p, i) => { o["press." + String(i).padStart(2, "0")] = Math.round(p.t); });
    return o;
  };
  window.filmInfo = async (ms) => {
    await ready;
    return {
      fonts: { funnel: document.fonts.check('500 60px "Funnel Display"'), geist: document.fonts.check('500 20px "Geist"'), faces: [...document.fonts].map((f) => f.family + " " + f.status) },
      cam: cameraAt(ms), speed: camSpeed(ms), ptr: pointerAt(ms), manifest: Object.keys(M), zmax: ZMAX,
      checkin: CK && { real: CK.real, src: CK.layer.src && CK.layer.src.split("/").slice(-2).join("/"), scale: CK.scale, start: CK.start },
      cards: Object.fromEntries(Object.keys(cardEls).map((n) => [n, cardEls[n].A.src && cardEls[n].A.src.split("/").slice(-2).join("/")])),
      events: Object.fromEntries(["ask", "saved", "track", "music", "habits", "work", "workDone", "hire"].map((s) => [s, Object.fromEntries(Object.keys(Object.assign({}, FALLBACK_EVENTS[s], (M[s] || {}).events)).map((e) => [e, Math.round(evF(s, e))]))])),
    };
  };
  window.seek(Number(q.get("t") || 0));
})();

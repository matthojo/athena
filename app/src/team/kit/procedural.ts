/**
 * Deterministic characters from a seed. Each part draws from its own salted
 * stream, so locking one part in the wardrobe never shifts the others.
 */
import type { AccessoryId, AvatarSpec, EyesId, MouthId, OutfitId, Personality, Species } from "./types";
import { OUTFITS_FOR_FUR } from "./palette";
import { ACCESSORIES, type Slot } from "./accessories";
import { SPECIES_IDS } from "./svg";

/** cyrb53-style 32-bit string hash. */
export function hash(str: string): number {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

/** mulberry32 stream for one seed and salt. */
export function stream(seed: string, salt: string): () => number {
  let a = hash(`${salt}:${seed}`);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const one = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length) % list.length];

function weighted<T extends string>(r: () => number, w: Partial<Record<T, number>>): T {
  const entries = Object.entries(w) as [T, number][];
  const total = entries.reduce((s, [, v]) => s + v, 0);
  let x = r() * total;
  for (const [k, v] of entries) if ((x -= v) < 0) return k;
  return entries[entries.length - 1][0];
}

/** Curated coat + accent pairs per species. */
export const LOOKS: Record<Species, [fur: string, accent: string][]> = {
  cat: [["charcoal", "rose"], ["snow", "pink"], ["honey", "peach"], ["slate", "pink"], ["cream", "rose"], ["ginger", "peach"]],
  bear: [["cocoa", "peach"], ["honey", "peach"], ["cream", "rose"], ["snow", "pink"], ["slate", "rose"], ["charcoal", "peach"]],
  fox: [["ginger", "coral"], ["honey", "coral"], ["snow", "sky"], ["cocoa", "peach"], ["slate", "rose"]],
  bunny: [["snow", "pink"], ["cream", "rose"], ["blush", "rose"], ["lilac", "pink"], ["sky", "butter"], ["slate", "pink"]],
  monster: [["mint", "lilac"], ["lilac", "mint"], ["sky", "butter"], ["butter", "coral"], ["blush", "lilac"], ["mint", "butter"]],
};

// Calm by default (16 Nov): round eyes lead; sparkle and the closed happy arcs are a treat, not the norm.
const EYE_WEIGHTS: Record<EyesId, number> = { round: 4, sparkle: 2, sleepy: 1.2, happy: 1 };

/**
 * Resting faces are calm. The big laugh and the tongue belong to the happy
 * mood, so a new character never rests on them; the owner can still pick
 * any mouth in the wardrobe.
 */
function mouthWeights(s: Species): Partial<Record<MouthId, number>> {
  return {
    "small-smile": 4,
    "cat-w": s === "cat" ? 4 : 1,
    "buck-teeth": s === "bunny" ? 2.4 : 0.3,
    "fang-grin": s === "monster" ? 1.6 : 0,
    smirk: 1,
    "button-nose": s === "monster" ? 1.4 : 0.8,
    "triangle-nose": s === "fox" ? 0.2 : 0.6,
    "heart-nose": 0.5,
  };
}

function outfitWeights(s: Species): Record<OutfitId, number> {
  return { tee: 2, hoodie: 1.6, polo: 1, overalls: 1.2, blazer: 0.8, vest: 0.8, collar: s === "cat" || s === "bear" ? 2.4 : 1 };
}

/**
 * Accessories a new character can be given. The party hat, crown and eye
 * patch stay in the wardrobe for the owner to choose; they are never rolled.
 */
export const ROLLED_ACCESSORIES: readonly AccessoryId[] = (Object.keys(ACCESSORIES) as AccessoryId[]).filter(
  (id) => id !== "party-hat" && id !== "crown" && id !== "eye-patch",
);

const SLOT_WEIGHTS: Record<Slot, number> = { head: 0.5, face: 0.25, neck: 0.25 };

/** About half wear nothing; the rest wear exactly one, from ROLLED_ACCESSORIES. */
export function accessoriesFromSeed(seed: string): AccessoryId[] {
  const r = stream(seed, "acc");
  if (r() < 0.5) return [];
  const slot = weighted(r, SLOT_WEIGHTS);
  return [one(r, ROLLED_ACCESSORIES.filter((id) => ACCESSORIES[id].slot === slot))];
}

export function avatarFromSeed(seed: string): AvatarSpec {
  const species = one(stream(seed, "species"), SPECIES_IDS);
  const [fur, accent] = one(stream(seed, "look"), LOOKS[species]);
  return {
    v: 1,
    seed,
    species,
    fur,
    accent,
    eyes: weighted(stream(seed, "eyes"), EYE_WEIGHTS),
    mouth: weighted(stream(seed, "mouth"), mouthWeights(species)),
    outfit: weighted(stream(seed, "outfit"), outfitWeights(species)),
    outfitColor: one(stream(seed, "outfitColor"), OUTFITS_FOR_FUR[fur] ?? ["cobalt"]),
    accessories: accessoriesFromSeed(seed),
  };
}

/** Parts the wardrobe's shuffle can hold still. "look" covers species, fur and accent together. */
export type LockPart = "species" | "fur" | "eyes" | "mouth" | "outfit" | "outfitColor" | "accessories";

/**
 * Re-roll a spec from a fresh seed, keeping locked parts. Fur stays harmonious:
 * an unlocked fur is drawn from the (possibly locked) species' looks.
 */
export function shuffleSpec(current: AvatarSpec, locks: ReadonlySet<LockPart>, nextSeed: string): AvatarSpec {
  const fresh = avatarFromSeed(nextSeed);
  const species = locks.has("species") ? current.species : fresh.species;
  let fur = fresh.fur, accent = fresh.accent;
  if (locks.has("fur")) ({ fur, accent } = current);
  else if (species !== fresh.species) [fur, accent] = one(stream(nextSeed, "look"), LOOKS[species]);
  const outfitColor = locks.has("outfitColor")
    ? current.outfitColor
    : one(stream(nextSeed, "outfitColor"), OUTFITS_FOR_FUR[fur] ?? ["cobalt"]);
  return {
    v: 1,
    seed: nextSeed,
    species,
    fur,
    accent,
    eyes: locks.has("eyes") ? current.eyes : fresh.eyes,
    mouth: locks.has("mouth") ? current.mouth : weighted(stream(nextSeed, "mouth"), mouthWeights(species)),
    outfit: locks.has("outfit") ? current.outfit : fresh.outfit,
    outfitColor,
    accessories: locks.has("accessories") ? [...current.accessories] : fresh.accessories,
  };
}

/** Short, friendly, easy to say aloud. No duplicates; none collide with Athena or Ask. */
export const NAMES = [
  "Tansy", "Dot", "Wren", "Pip", "Juno", "Moss", "Fig", "Bean", "Luna", "Otis",
  "Mabel", "Bo", "Kit", "Rue", "Ziggy", "Nell", "Pico", "Hazel", "Tate", "Clover",
  "Biscuit", "Sunny", "Pepper", "Miso", "Tofu", "Olive", "Basil", "Poppy", "Rory", "Ivy",
  "Milo", "Nova", "Remy", "Sage", "Toby", "Willa", "Arlo", "Bree", "Cosmo", "Daisy",
  "Ezra", "Fern", "Gus", "Hugo", "Iris", "Jojo", "Kiki", "Lark", "Mochi", "Nico",
  "Ollie", "Penny", "Quill", "Rosie", "Scout", "Tilly", "Umi", "Vesper", "Waffles", "Yuki",
  "Zola", "Acorn", "Bramble", "Cricket", "Dumpling", "Ember", "Finch", "Ginger", "Honey", "Inky",
  "Jasper", "Kiwi", "Lumi", "Maple", "Noodle", "Opal", "Pudding", "Robin", "Sprout", "Teddy",
] as const;

/** Pass the names already on the team to skip them (deterministically) where possible. */
export function nameFromSeed(seed: string, taken: readonly string[] = []): string {
  const start = Math.floor(stream(seed, "name")() * NAMES.length) % NAMES.length;
  const used = new Set(taken.map((n) => n.toLowerCase()));
  for (let i = 0; i < NAMES.length; i++) {
    const name = NAMES[(start + i) % NAMES.length];
    if (!used.has(name.toLowerCase())) return name;
  }
  return NAMES[start];
}

type Tone = Personality["tone"];
const TONES: Tone[] = ["warm", "crisp", "playful", "calm", "wry"];

export const TRAITS: Record<Tone, string[]> = {
  warm: ["kind", "patient", "encouraging", "thoughtful", "gentle", "upbeat"],
  crisp: ["precise", "brisk", "organised", "direct", "reliable", "tidy"],
  playful: ["curious", "cheerful", "chatty", "bright", "bouncy", "inventive"],
  calm: ["steady", "unhurried", "quiet", "careful", "level-headed", "patient"],
  wry: ["dry", "sharp", "candid", "deadpan", "clever", "unfussy"],
};

export const GREETINGS: Record<Tone, string[]> = {
  warm: ["Hello! I'm glad to be on your team.", "Hi there. I'll look after this one for you.", "Hello! Leave this with me."],
  crisp: ["Ready when you are.", "Got it. I'll keep this tidy.", "Hi. I know the job. Let's start."],
  playful: ["Ooh, a job! Let's go.", "Hi hi! This is going to be fun.", "Hello! I've been waiting for this one."],
  calm: ["Hello. I'll keep an eye on things.", "Hi. No rush. I've got this.", "Hello. I'll take it from here, quietly."],
  wry: ["Reporting for duty. Mostly.", "Hi. I'll do the dull bits so you don't have to.", "Hello. Finally, something to do."],
};

export function personalityFromSeed(seed: string): Personality {
  const r = stream(seed, "personality");
  const tone = one(r, TONES);
  const pool = TRAITS[tone];
  const first = Math.floor(r() * pool.length) % pool.length;
  let second = Math.floor(r() * (pool.length - 1)) % (pool.length - 1);
  if (second >= first) second++;
  const p = r();
  const pronoun: Personality["pronoun"] = p < 0.34 ? "they" : p < 0.67 ? "she" : "he";
  return { tone, traits: [pool[first], pool[second]], pronoun, greeting: one(r, GREETINGS[tone]) };
}

/**
 * Mirrors the Team spec's avatar types (docs/team.md, "Shared types").
 * lib/team-types.ts is the canonical home; these are structurally identical
 * so either import satisfies the other. MouthId is spelled out here because
 * the spec only says "the 12 on the mouth sheet".
 */

export type Species = "cat" | "bear" | "fox" | "bunny" | "monster";

/** The 12 on docs/team-art/mouths-sheet.svg, in sheet order. The last three are noses. */
export type MouthId =
  | "small-smile"
  | "big-laugh"
  | "wavy-frown"
  | "cat-w"
  | "buck-teeth"
  | "fang-grin"
  | "surprised-o"
  | "smirk"
  | "tongue-out"
  | "button-nose"
  | "triangle-nose"
  | "heart-nose";

export type EyesId = "round" | "sparkle" | "sleepy" | "happy";
export type OutfitId = "tee" | "hoodie" | "polo" | "overalls" | "blazer" | "vest" | "collar";

export type AccessoryId =
  | "beanie"
  | "glasses"
  | "party-hat"
  | "bow"
  | "flowers"
  | "headphones"
  | "eye-patch"
  | "scarf"
  | "crown"
  | "heart-necklace";

export interface AvatarSpec {
  v: 1;
  seed: string;
  species: Species;
  fur: string; // palette keys, see palette.ts
  accent: string;
  eyes: EyesId;
  mouth: MouthId; // the 12 on the mouth sheet
  outfit: OutfitId;
  outfitColor: string;
  accessories: AccessoryId[]; // at most one head, one face, one neck
}

export interface Personality {
  tone: "warm" | "crisp" | "playful" | "calm" | "wry";
  traits: string[];
  pronoun: "she" | "he" | "they";
  greeting: string;
}

/** idle blinks; thinking tilts, eyes up; happy smiles with its eyes; working looks down at a laptop and types. */
export type Mood = "idle" | "thinking" | "happy" | "working";

export interface RenderOptions {
  size: number;
  mood?: Mood;
  animate?: boolean;
  /** "head" crops to the face for chips and bubbles. Defaults to "head" under 40px, where the simplified small head is drawn. */
  frame?: "full" | "head";
  /** The assistant's name. Not drawn; kept so every caller passes the same options. */
  name?: string;
}

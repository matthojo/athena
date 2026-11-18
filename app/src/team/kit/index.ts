/**
 * Team character kit. The avatar contract (docs/team.md, "Contracts between
 * slices") lives here; app/src/team/avatar.ts re-exports it.
 */
export type { AccessoryId, AvatarSpec, EyesId, Mood, MouthId, OutfitId, Personality, RenderOptions, Species } from "./types";
export { renderAvatar, renderAvatarTile, setAvatarMood, updateAvatar } from "./render";
export { avatarFromSeed, nameFromSeed, personalityFromSeed, shuffleSpec, type LockPart } from "./procedural";
export { avatarMarkup, normalizeSpec } from "./svg";
export { avatarTint } from "./palette";
export { wardrobe } from "./wardrobe";

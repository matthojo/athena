/**
 * Team: an assistant's character.
 *
 *   renderAvatar(spec, { size, mood?, animate?, frame? }) → <svg>
 *   renderAvatarTile(spec, { size, mood?, animate? }) → <span class="kit-tile"> (every Team surface)
 *   avatarFromSeed(seed) · personalityFromSeed(seed) · nameFromSeed(seed, taken?)
 *
 * The one place the app imports characters from. Drawing, moods, the
 * wardrobe and shuffling come from the kit (./kit); the seed functions come
 * through lib/team-seed.ts so the server makes the same characters.
 */
export { renderAvatar, renderAvatarTile, setAvatarMood, updateAvatar, avatarMarkup, normalizeSpec, avatarTint, shuffleSpec, wardrobe, type LockPart, type Mood as AvatarMood, type RenderOptions as AvatarOptions } from "./kit";
export { avatarFromSeed, nameFromSeed, newSeed, personalityFromSeed } from "../../../lib/team-seed";

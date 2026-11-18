/**
 * Place names as a sentence says them (the day handed back, lib/nudges.ts
 * eveningLine): "at the Barbican", "at the British Museum", "at Dishoom".
 *
 * A name that ends in a venue word takes "the" ("British Museum" → "the
 * British Museum", "Royal Albert Hall" → "the Royal Albert Hall"). A
 * one-word name plus Centre is said the way people say it: "Barbican
 * Centre" → "the Barbican", "Southbank Centre" → "the Southbank". Anything
 * else (a restaurant, a park, a street, "Tate Modern") stays as the owner
 * named it, as does a name that already starts with "The".
 */

/**
 * Venue words that take "the" when they end a name. Left out on purpose, as
 * the name usually goes bare: Park, Heath, Market, Stadium, Arena, Abbey,
 * Palace, Cathedral and Zoo ("Hyde Park", "Borough Market", "Wembley
 * Stadium", "Westminster Abbey"). Hall takes it only after Royal or
 * National ("the Royal Albert Hall", but "Wigmore Hall").
 */
const VENUE = /\b(centre|center|theatre|theater|museum|gallery|library|cinema|playhouse|opera house|planetarium|aquarium)$/i;
const HALL = /^(royal|national)\b.*\bhall$/i;

/** Words before "Centre" that make it a kind of place, not a name: "Garden Centre" stays "the Garden Centre". */
const KIND = /^(garden|leisure|sports?|shopping|community|arts|town|city|visitor|conference|exhibition|activity|climbing|tennis|fitness|youth|day|heritage)$/i;

export function placeWithArticle(name: string): string {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n || /^the\s/i.test(n)) return n;
  if (!VENUE.test(n) && !HALL.test(n)) return n;
  // A possessive owns it already: "Ronnie Scott's Jazz Club" style names, "St Paul's Cathedral".
  if (/'s\b|’s\b/.test(n)) return n;
  const words = n.split(" ");
  if (words.length === 1) return n;
  if (words.length === 2 && /^cent(re|er)$/i.test(words[1]) && !KIND.test(words[0])) return `the ${words[0]}`;
  return `the ${n}`;
}

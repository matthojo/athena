/** How the owner gets somewhere, in the app's words: Settings → Notifications and an event's "Getting there". */
import type { TravelMode } from "../../../lib/proactive/types";

export const TRAVEL_WORDS: Record<TravelMode, string> = { transit: "Public transport", drive: "Drive", walk: "Walk", cycle: "Cycle" };

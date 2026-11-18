import type { ProviderId } from "../model-types";

/** A provider this deploy can't reach, or one not built yet. The owner reads `message`. */
export class ProviderUnavailable extends Error {
  constructor(public provider: ProviderId, message = "That model isn't available on this deploy.") {
    super(message);
  }
}

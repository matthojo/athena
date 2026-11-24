/**
 * The Community catalogue, read by Athena's own server. NOT BUILT YET: a stub with its final signature, so the Add
 * screen (netlify/lib/community-add-routes.ts) can call it. The Community session replaces this file.
 */
import type { CatalogueBundle, CatalogueItem } from "../../lib/catalogue-types";

/** One listing from the index and its bundle, read and checked. Not built yet. */
export async function loadBundle(id: string): Promise<{ item: CatalogueItem; bundle: CatalogueBundle }> {
  void id;
  throw new Error("not built yet");
}

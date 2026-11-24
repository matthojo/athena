/**
 * Sample mode's Community catalogue. NOT BUILT YET: a stub with its final signature, so the Add screen can call it.
 * The Community session replaces this file.
 */
import type { CatalogueBundle, CatalogueItem } from "../../../lib/catalogue-types";

/** A made-up listing and its bundle, for `#/add?catalogue=<id>` in sample mode. Not built yet. */
export async function sampleBundle(id: string): Promise<{ item: CatalogueItem; bundle: CatalogueBundle }> {
  void id;
  throw new Error("not built yet");
}

/**
 * The biggest single file an import reads into memory. Takeout zips are read
 * piece by piece (lib/takeout-zip.ts) and have their own limits; this is for
 * a plain JSON, HTML or CSV file, where one too big would freeze the tab.
 */
export const MAX_FILE_BYTES = 300 * 2 ** 20;
/** Netflix and Goodreads CSVs are a few MB at most. */
export const MAX_CSV_BYTES = 50 * 2 ** 20;

export const TOO_BIG = "That file is too big to read here. Check it's the right one.";

export class FileTooBig extends Error {
  constructor() {
    super("file too big");
  }
}

/** A picked file's text, refused before reading when it's over `max`. */
export async function readText(file: Blob, max = MAX_FILE_BYTES): Promise<string> {
  if (file.size > max) throw new FileTooBig();
  return file.text();
}

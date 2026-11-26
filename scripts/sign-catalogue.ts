/**
 * Signs the Community catalogue's index.json, for its build: writes index.json.sig beside it (lib/catalogue-signature.ts).
 *
 *   CATALOGUE_SIGNING_KEY=… npx tsx scripts/sign-catalogue.ts path/to/index.json
 *   CATALOGUE_SIGNING_KEY=… npx tsx scripts/sign-catalogue.ts --public-key
 *   npx tsx scripts/sign-catalogue.ts --help
 *
 * The private key comes from the CATALOGUE_SIGNING_KEY environment variable only, never from a file in either
 * repository: an Ed25519 key as PEM, or as base64 of its PKCS#8 DER bytes on one line. --public-key prints the
 * line that goes in CATALOGUE_SIGNING_KEYS (lib/catalogue-types.ts). Sign after the last change to index.json: the
 * signature covers its exact bytes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listedPublicKey, privateKeyFrom, signIndex, verifyIndexSignature } from "../lib/catalogue-signature";
import { INDEX_SIGNATURE_FILE } from "../lib/catalogue-types";

export const ENV_KEY = "CATALOGUE_SIGNING_KEY";

export const HELP = `Sign the Community catalogue's index.json.

  ${ENV_KEY}=… npx tsx scripts/sign-catalogue.ts path/to/index.json   writes ${INDEX_SIGNATURE_FILE} beside it
  ${ENV_KEY}=… npx tsx scripts/sign-catalogue.ts --public-key         prints the public key to list

Make a key pair once, somewhere outside both repositories:

  openssl genpkey -algorithm ed25519 -outform DER | base64 | tr -d '\\n'

Keep that line as the ${ENV_KEY} secret where the catalogue is built (a PEM key works too:
openssl genpkey -algorithm ed25519). Then run --public-key with it set, and add the line it prints to
CATALOGUE_SIGNING_KEYS in lib/catalogue-types.ts. To rotate, list the new key beside the old one, sign
with the new one, and remove the old one a release later.`;

/** index.json's signature, checked against the key's own public half before it's written. */
export function signFile(indexPath: string, keyText: string): { sigPath: string; publicKey: string } {
  const key = privateKeyFrom(keyText);
  const body = readFileSync(indexPath);
  const signature = signIndex(body, key);
  const publicKey = listedPublicKey(key);
  if (!verifyIndexSignature(body, signature, [publicKey])) throw new Error("The signature didn't verify");
  const sigPath = `${indexPath}.sig`;
  writeFileSync(sigPath, `${signature}\n`);
  return { sigPath, publicKey };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  const keyText = process.env[ENV_KEY];
  if (!arg || arg === "--help" || arg === "-h") {
    console.log(HELP);
  } else if (!keyText?.trim()) {
    console.error(`Set ${ENV_KEY} to the catalogue's private key.\n\n${HELP}`);
    process.exit(1);
  } else if (arg === "--public-key") {
    console.log(listedPublicKey(privateKeyFrom(keyText)));
  } else {
    const { sigPath, publicKey } = signFile(arg, keyText);
    console.log(`Wrote ${sigPath} (key ${publicKey})`);
  }
}

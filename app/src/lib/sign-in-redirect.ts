/**
 * Sending the browser to an account's sign-in page. For a custom MCP server
 * the address comes from the server's own OAuth metadata, so it's opened
 * only when it's https (or plain http to this same machine while Athena
 * itself runs there, under `netlify dev`): never javascript:, data: or the
 * like.
 */

/** Whether `raw` may be opened as a sign-in page from a page at `here`. */
export function isSignInAddress(raw: string, here: { protocol: string; hostname: string }): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  const local = (host: string) => host === "localhost" || host === "127.0.0.1";
  return url.protocol === "http:" && local(url.hostname) && here.protocol === "http:" && local(here.hostname);
}

/** Go to the sign-in page, or throw (shown as the usual error toast) if the address isn't one to open. */
export function goToSignIn(raw: string): void {
  if (!isSignInAddress(raw, location)) throw new Error("The server's sign-in address isn't https, so Athena won't open it");
  location.assign(raw);
}

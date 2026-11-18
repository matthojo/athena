/** Pictures' fixed words, shared by the server (lib/images.ts, lib/answer.ts) and the app. Pure. */

/** Under a reply when the owner asked for a picture and pictures are off. */
export const PICTURE_SETTING = { label: "Turn on pictures", href: "#/settings/models" };
export const PICTURES_OFF_TEXT = "Pictures are off, so I can't make one yet. Choose a picture model in Settings, AI models, and ask me again.";
export const CANT_CHANGE =
  "OpenAI's picture models can only make new pictures, not change one. To change pictures, choose a Gemini picture model in Settings, AI models.";

/**
 * The car: DVLA's Vehicle Enquiry and DVSA's MOT History, each a key the
 * owner pastes in Sources → Places and travel, like the live travel keys
 * (lib/presets/live-travel.ts). Joined into CONNECTOR_PRESETS by
 * lib/connector-presets.ts.
 *
 * Neither feeds a collection or is offered to Claude: the car sync
 * (lib/car-sync.ts, netlify/lib/car-api.ts) calls them itself once a day for
 * the registrations the owner adds on either account's page. Either one is
 * enough: DVLA alone gives tax and MOT dates; DVSA alone gives the MOT date
 * and the test history.
 */
import type { ConnectorPreset } from "../connector-presets";

export const CAR_PROVIDERS = ["dvla", "dvsa-mot"] as const;
export type CarProvider = (typeof CAR_PROVIDERS)[number];
export const isCarProvider = (p: string): p is CarProvider => (CAR_PROVIDERS as readonly string[]).includes(p);

/** Athena calls these itself, with the key. */
export function carDirect(c: { provider: string; auth_type: string }): boolean {
  return isCarProvider(c.provider) && c.auth_type === "token";
}

export const DVLA_REGISTER_URL = "https://developer-portal.driver-vehicle-licensing.api.gov.uk/apis/vehicle-enquiry-service/vehicle-enquiry-service-description.html";
export const DVSA_REGISTER_URL = "https://submit.forms.service.gov.uk/form/2382/register-for-mot-history-api/7519";

export const CAR_PRESETS: ConnectorPreset[] = [
  {
    id: "dvla",
    label: "DVLA",
    tagline: "Tax and MOT dates for your car",
    icon: "car",
    category: "travel",
    aliases: ["car", "vehicle", "car tax", "road tax", "vehicle tax", "mot", "vehicle enquiry", "ves", "dvla", "registration"],
    url: "https://driver-vehicle-licensing.api.gov.uk",
    auth: "token",
    scope: "",
    readTools: [],
    recipes: [],
    setup: {
      minutes: 5,
      steps: [
        {
          title: "Ask DVLA for a Vehicle Enquiry key",
          sub: "It's free. DVLA sometimes stops taking new requests for a while. If it has, the DVSA key on its own still gives your MOT date.",
          open: DVLA_REGISTER_URL,
        },
        { title: "Copy the key from DVLA's email" },
      ],
      paste: { title: "Paste the key here", sub: "Athena checks it without sending a registration." },
    },
    help: "Once a day, Athena sends DVLA the registration numbers you add and gets back each car's make, colour, year, tax status and MOT expiry. Tax and MOT dates go into Life admin, with a reminder about 30 days and 7 days before. Nothing else is sent.",
    live: {
      meta: "Tax and MOT dates",
      foot: "Athena sends DVLA only the registration numbers you add.",
      added: { title: "Tax and MOT dates in Life admin", sentence: "Add a registration number under Your cars, and its tax and MOT dates go into Life admin." },
    },
  },
  {
    id: "dvsa-mot",
    label: "DVSA MOT history",
    tagline: "MOT results, mileage and advisories",
    icon: "car",
    category: "travel",
    aliases: ["car", "vehicle", "mot", "mot history", "advisories", "mileage", "dvsa", "registration"],
    url: "https://history.mot.api.gov.uk",
    auth: "token",
    scope: "",
    readTools: [],
    recipes: [],
    clientCredentials: { hint: "https://login.microsoftonline.com/…/oauth2/v2.0/token" },
    setup: {
      minutes: 5,
      steps: [
        { title: "Register for the MOT History API", sub: "It's free. DVSA asks for your name, email and postal address, and can take up to 5 working days to reply.", open: DVSA_REGISTER_URL },
        { title: "Open DVSA's email", sub: "It has four things you need: a client ID, a client secret, an API key and a token URL." },
      ],
      paste: { title: "Paste all four here", sub: "Athena checks them without sending a registration." },
    },
    help: "Once a day, Athena sends DVSA the registration numbers you add and gets back each MOT test: pass or fail, the mileage, and any advisories. It's optional: without it, the MOT date still comes from DVLA. Nothing else is sent.",
    live: {
      meta: "MOT history and advisories",
      foot: "Athena sends DVSA only the registration numbers you add.",
      added: { title: "MOT history in Life admin", sentence: "Add a registration number under Your cars, and its MOT history shows in Life admin." },
    },
  },
];

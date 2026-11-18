// Builds dist/<target>/ for chrome, firefox and safari, and with --zip the
// store uploads. No dependencies: Node 22's zlib does the zipping.
//   node scripts/build.mjs [chrome|firefox|safari ...] [--zip] [--e2e]

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const zip = args.includes("--zip");
const e2e = args.includes("--e2e");
const targets = args.filter((a) => !a.startsWith("--"));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const FONTS = ["geist-latin.woff2", "funnel-display-latin.woff2"];

export function manifest(target, { e2e = false } = {}) {
  const m = {
    manifest_version: 3,
    name: "Save to Athena",
    short_name: "Athena",
    version,
    description: "Save the page, a quote, an image or a link to your own Athena.",
    icons: { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" },
    action: {
      default_title: "Save to Athena",
      default_popup: "popup.html",
      default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png" },
    },
    options_ui: { page: "options.html", open_in_tab: true },
    permissions: ["activeTab", "alarms", "contextMenus", "scripting", "storage"],
    // Asked for at runtime, for the owner's Athena address only.
    optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
    commands: {
      "save-page": { suggested_key: { default: "Alt+Shift+S" }, description: "Save the page to Athena" },
    },
    background: { service_worker: "background.js", type: "module" },
  };
  if (target === "chrome") m.minimum_chrome_version = "116";
  if (target === "firefox") {
    m.background = { scripts: ["background.js"], type: "module" };
    m.browser_specific_settings = {
      gecko: {
        // Mozilla needs an id of your own to sign the add-on: set ATHENA_GECKO_ID.
        id: process.env.ATHENA_GECKO_ID || "save-to-athena@example.com",
        strict_min_version: "128.0",
        data_collection_permissions: { required: ["none"] },
      },
    };
  }
  // The e2e build is granted its mock server up front: a test can't click a permission prompt.
  if (e2e) m.host_permissions = ["http://127.0.0.1/*"];
  return m;
}

function build(target) {
  const out = join(root, "dist", e2e ? `${target}-e2e` : target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(root, "src"), out, { recursive: true });
  mkdirSync(join(out, "fonts"), { recursive: true });
  for (const font of FONTS) {
    const from = join(root, "..", "app", "public", "fonts", font);
    if (existsSync(from)) cpSync(from, join(out, "fonts", font));
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest(target, { e2e }), null, 2) + "\n");
  if (zip) {
    const file = join(root, "dist", `save-to-athena-${target}-${version}.zip`);
    writeFileSync(file, zipDir(out));
    console.log(relative(root, file));
  } else {
    console.log(relative(root, out));
  }
}

function files(dir, base = dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path, base) : [relative(base, path).split("\\").join("/")];
    });
}

/** A plain zip (deflate), with a fixed timestamp so builds are repeatable. */
function zipDir(dir) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
  for (const name of files(dir)) {
    const data = readFileSync(join(dir, name));
    const packed = deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const target of targets.length ? targets : ["chrome", "firefox", "safari"]) build(target);
}

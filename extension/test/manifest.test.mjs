import test from "node:test";
import assert from "node:assert/strict";
import { manifest } from "../scripts/build.mjs";

test("permissions stay minimal and host access is asked for at runtime", () => {
  for (const target of ["chrome", "firefox", "safari"]) {
    const m = manifest(target);
    assert.deepEqual(m.permissions, ["activeTab", "alarms", "contextMenus", "scripting", "storage"]);
    assert.equal(m.host_permissions, undefined, `${target}: no host access at install`);
    assert.equal(m.content_scripts, undefined);
  }
  assert.ok(manifest("firefox").browser_specific_settings.gecko.id);
  assert.deepEqual(manifest("firefox").background.scripts, ["background.js"]);
  assert.equal(manifest("chrome").background.service_worker, "background.js");
  assert.deepEqual(manifest("chrome", { e2e: true }).host_permissions, ["http://127.0.0.1/*"]);
});

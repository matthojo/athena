import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeConnectError, applianceItem, homeConnectAdapter, homeConnectAuthorizationUrl, readAppliances, readProgram, readStatus } from "./homeconnect-direct";

test("what a status reply and an active programme say", () => {
  assert.deepEqual(
    readStatus({ status: [{ key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Run" }, { key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Closed" }, { key: "BSH.Common.Status.RemoteControlActive", value: true }] }),
    { state: "Run", door: "Closed" },
  );
  assert.deepEqual(readStatus(null), {});
  assert.deepEqual(
    readProgram({
      key: "Dishcare.Dishwasher.Program.Eco50",
      name: "Eco 50°C",
      options: [
        { key: "BSH.Common.Option.RemainingProgramTime", value: 4800, unit: "seconds" },
        { key: "BSH.Common.Option.ElapsedProgramTime", value: 2400, unit: "seconds" },
        { key: "BSH.Common.Option.ProgramProgress", value: 33, unit: "%" },
        { key: "Dishcare.Dishwasher.Option.ExtraDry", value: true },
      ],
    }),
    { program: { key: "Dishcare.Dishwasher.Program.Eco50", name: "Eco 50°C" }, remaining_s: 4800, elapsed_s: 2400, progress: 33 },
  );
  assert.deepEqual(readProgram({}), {});
});

test("a look: one request for the list, one per connected appliance, one more for one that's running", async () => {
  const asked: string[] = [];
  const get = async <T>(path: string): Promise<T> => {
    asked.push(path);
    if (path === "/homeappliances")
      return {
        data: {
          homeappliances: [
            { haId: "BOSCH-SMV-1", name: "Dishwasher", type: "Dishwasher", brand: "Bosch", connected: true },
            { haId: "SIEMENS-WM-2", name: "", type: "Washer", brand: "Siemens", connected: true },
            { haId: "NEFF-OVEN-3", name: "Oven", type: "Oven", brand: "Neff", connected: false },
            { haId: "bad id/../x", name: "Odd", type: "Hob", brand: "", connected: true },
          ],
        },
      } as T;
    if (path === "/homeappliances/BOSCH-SMV-1/status") return { data: { status: [{ key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Run" }] } } as T;
    if (path === "/homeappliances/BOSCH-SMV-1/programs/active") return { data: { key: "Dishcare.Dishwasher.Program.Eco50", options: [{ key: "BSH.Common.Option.RemainingProgramTime", value: 600, unit: "seconds" }] } } as T;
    if (path === "/homeappliances/SIEMENS-WM-2/status") return { data: { status: [{ key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Finished" }] } } as T;
    throw new Error(`unexpected ${path}`);
  };
  const got = await readAppliances(get);
  assert.deepEqual(asked, ["/homeappliances", "/homeappliances/BOSCH-SMV-1/status", "/homeappliances/BOSCH-SMV-1/programs/active", "/homeappliances/SIEMENS-WM-2/status"]);
  assert.deepEqual(got, [
    { id: "BOSCH-SMV-1", name: "Dishwasher", type: "Dishwasher", brand: "Bosch", connected: true, state: "Run", program: { key: "Dishcare.Dishwasher.Program.Eco50" }, remaining_s: 600 },
    { id: "SIEMENS-WM-2", name: "", type: "Washer", brand: "Siemens", connected: true, state: "Finished" },
    { id: "NEFF-OVEN-3", name: "Oven", type: "Oven", brand: "Neff", connected: false },
  ]);
  assert.deepEqual(applianceItem(got[0]), { name: "Dishwasher", what: "Dishwasher", brand: "Bosch", now: "Running Eco 50, 10m left", programme: "Eco 50", minutes_left: 10 });
  assert.deepEqual(applianceItem(got[1]), { name: "Washing machine", what: "Washing machine", brand: "Siemens", now: "Finished" });
});

test("an appliance that went offline, or stopped, between the list and its status says less; anything else is the account's problem", async () => {
  const list = { data: { homeappliances: [{ haId: "A-1", name: "Dishwasher", type: "Dishwasher", brand: "Bosch", connected: true }] } };
  const offline = await readAppliances(async <T>(path: string) => {
    if (path === "/homeappliances") return list as T;
    throw new HomeConnectError(409, "offline");
  });
  assert.deepEqual(offline, [{ id: "A-1", name: "Dishwasher", type: "Dishwasher", brand: "Bosch", connected: false }]);
  const stopped = await readAppliances(async <T>(path: string) => {
    if (path === "/homeappliances") return list as T;
    if (path.endsWith("/status")) return { data: { status: [{ key: "BSH.Common.Status.OperationState", value: "x.Run" }] } } as T;
    throw new HomeConnectError(404, "no programme");
  });
  assert.deepEqual(stopped, [{ id: "A-1", name: "Dishwasher", type: "Dishwasher", brand: "Bosch", connected: true, state: "Run" }]);
  await assert.rejects(
    readAppliances(async <T>(path: string) => {
      if (path === "/homeappliances") return list as T;
      throw new HomeConnectError(429, "slow down");
    }),
    (e) => e instanceof HomeConnectError && e.status === 429,
  );
});

test("the sign-in asks only to see appliances, with PKCE; a refusal is never retried; the one tool only reads", () => {
  const url = new URL(homeConnectAuthorizationUrl({ clientId: "abc", redirectUri: "https://athena.test/api/oauth/callback", scope: "", state: "s", challenge: "c" }));
  assert.equal(`${url.origin}${url.pathname}`, "https://api.home-connect.com/security/oauth/authorize");
  assert.equal(url.searchParams.get("scope"), "IdentifyAppliance Monitor");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge"), "c");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(new HomeConnectError(429, "x").retryable, false);
  assert.equal(new HomeConnectError(503, "x").retryable, false);
  const tools = homeConnectAdapter.tools({ provider: "home-connect", scope: "" });
  assert.deepEqual(tools.map((t) => [t.name, t.annotations.readOnlyHint]), [["appliances", true]]);
  assert.equal(homeConnectAdapter.handles({ provider: "home-connect", auth_type: "oauth", oauth: {} }), true);
  assert.equal(homeConnectAdapter.handles({ provider: "home-connect", auth_type: "token", oauth: {} }), false);
});

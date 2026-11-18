// Run: npx tsx --test lib/carriers.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { carrierFromNumber, carrierNamed, trackingLink } from "./carriers";

const link = (carrier: string, tracking_number: string, tracking_url = "") => trackingLink({ carrier, tracking_number, tracking_url });

test("each carrier builds its own page from the number", () => {
  const cases: Array<[string, string, string]> = [
    ["Royal Mail", "AB 1234 5678 9GB", "https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB"],
    ["Parcelforce", "pb1234567", "https://www.parcelforce.com/track-trace?trackNumber=PB1234567"],
    ["Evri", "H00A1A0012345678", "https://www.evri.com/track/parcel/H00A1A0012345678"],
    ["DPD", "1550 1234 5678 90", "https://track.dpd.co.uk/parcels/15501234567890"],
    ["DHL", "1234567890", "https://www.dhl.com/gb-en/home/tracking.html?tracking-id=1234567890&submit=1"],
    ["UPS", "1Z999AA10123456784", "https://www.ups.com/track?tracknum=1Z999AA10123456784"],
    ["Amazon", "TBA123456789000", "https://track.amazon.co.uk/tracking/TBA123456789000"],
    ["InPost", "JJD0002233573349", "https://inpost.co.uk/tracking/result?parcel_code=JJD0002233573349"],
    ["FedEx", "123456789012", "https://www.fedex.com/fedextrack/?trknbr=123456789012"],
  ];
  for (const [carrier, number, url] of cases) {
    const got = link(carrier, number);
    assert.equal(got?.url, url, carrier);
    assert.equal(got?.carrier, carrier);
    assert.equal(got?.built, true);
  }
});

test("names as emails write them", () => {
  const names: Array<[string, string]> = [
    ["Royal Mail Tracked 24", "Royal Mail"],
    ["royalmail", "Royal Mail"],
    ["Hermes", "Evri"],
    ["DPD Local", "DPD"],
    ["DHL Parcel UK", "DHL"],
    ["DHL Express", "DHL"],
    ["Amazon Logistics", "Amazon"],
    ["Yodel", "InPost"],
    ["Fed Ex", "FedEx"],
    ["UPS Standard", "UPS"],
    ["ParcelForce Worldwide", "Parcelforce"],
  ];
  for (const [given, name] of names) assert.equal(carrierNamed(given)?.name, name, given);
  assert.equal(carrierNamed("APC Overnight"), null);
  assert.equal(carrierNamed(""), null);
  assert.equal(carrierNamed("Groups"), null);
});

test("a number only one carrier uses finds it without a name", () => {
  assert.equal(carrierFromNumber("1Z999AA10123456784")?.name, "UPS");
  assert.equal(carrierFromNumber("TBA123456789000")?.name, "Amazon");
  assert.equal(carrierFromNumber("ab123456789gb")?.name, "Royal Mail");
  assert.equal(carrierFromNumber("H00A1A0012345678")?.name, "Evri");
  assert.equal(carrierFromNumber("15501234567890")?.name, "DPD");
  assert.equal(carrierFromNumber("JJD000123456789")?.name, "DHL");
  // Could be several carriers: no guess.
  assert.equal(carrierFromNumber("1234567890"), null);
  assert.equal(link("", "1234567890"), null);
  assert.equal(link("", "1Z999AA10123456784")?.url, "https://www.ups.com/track?tracknum=1Z999AA10123456784");
});

test("a given link wins, and only web links count", () => {
  assert.deepEqual(link("Royal Mail", "AB123456789GB", "https://example-shop.com/track/9"), { url: "https://example-shop.com/track/9", carrier: "Royal Mail", built: false });
  assert.equal(link("", "", "evri.com/track/parcel/H1")?.url, "https://evri.com/track/parcel/H1");
  assert.equal(link("Evri", "H00A1A0012345678", "javascript:alert(1)")?.url, "https://www.evri.com/track/parcel/H00A1A0012345678");
  assert.equal(link("", "", "not a link"), null);
});

test("an unknown carrier never borrows another's page", () => {
  assert.equal(link("APC Overnight", "1Z999AA10123456784"), null);
  assert.equal(link("Royal Mail", ""), null);
});

test("numbers are encoded into the link", () => {
  assert.equal(link("Evri", "H00A/../x")?.url, "https://www.evri.com/track/parcel/H00AX");
});

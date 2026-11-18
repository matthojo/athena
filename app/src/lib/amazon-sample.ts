/**
 * A made-up Amazon export for sample mode (components/amazon-import.ts): CSVs
 * shaped like Amazon's, about two years of orders, returns, Kindle sessions,
 * Audible listening and Prime Video, ending yesterday. Seeded, so the
 * preview and screenshots are the same every time.
 */

const ORDERS: Array<[string, number]> = [
  ["Russell Hobbs Kettle, 1.7L", 24.99],
  ["Merino Walking Socks, Grey", 17.0],
  ["Enamel Camping Mug", 12.0],
  ["Bamboo Chopping Board Set", 21.5],
  ["Paperwhite Cover, Sage", 19.99],
  ["Linen Tea Towels, 3 Pack", 14.0],
  ["Waterproof Running Jacket", 64.0],
  ["AA Rechargeable Batteries, 8 Pack", 15.49],
  ["Cast Iron Skillet, 26cm", 34.99],
  ["Houseplant Feed", 6.99],
  ["Ceramic Plant Pot, Terracotta", 18.0],
  ["Noise-Cancelling Earbuds", 89.0],
  ["Notebook, Dotted A5", 9.5],
  ["Bike Light Set", 22.0],
  ["Coffee Grinder, Burr", 49.99],
  ["Reading Lamp, Clip-On", 16.99],
  ["Wool Beanie, Navy", 12.99],
  ["Picture Frames, 4 Pack", 27.0],
  ["Jigsaw, 1000 Pieces", 15.0],
  ["Dog Lead, Reflective", 11.99],
];

const BOOKS: Array<[string, string, string]> = [
  ["B0SAMPLEK1", "Tomorrow, and Tomorrow, and Tomorrow", "Gabrielle Zevin"],
  ["B0SAMPLEK2", "The Salt Path", "Raynor Winn"],
  ["B0SAMPLEK3", "Piranesi", "Susanna Clarke"],
  ["B0SAMPLEK4", "Small Things Like These", "Claire Keegan"],
  ["B0SAMPLEK5", "Prophet Song", "Paul Lynch"],
];

const LISTENS: Array<[string, string, string, number]> = [
  ["B0SAMPLEA1", "Project Hail Mary", "Andy Weir", 16 * 60],
  ["B0SAMPLEA2", "The Thursday Murder Club", "Richard Osman", 12 * 60],
  ["B0SAMPLEA3", "Educated", "Tara Westover", 12 * 60],
];

const SHOWS: Array<[string, number, string[]]> = [
  ["Slow Horses", 3, ["Strange Games", "Negotiating with Tigers", "Footprints", "Hello Goodbye", "Uncivil Partnership", "Tall Tales"]],
  ["The Boys", 2, ["The Big Ride", "Proper Preparation and Planning", "Over the Hill with the Swords of a Thousand Men", "Nothing Like It in the World"]],
  ["Clarkson's Farm", 3, ["Little Piggies", "Ploughing On", "Baby Love", "Rain Check"]],
];
const FILMS = ["Knives Out", "Saltburn", "The Holdovers", "Past Lives"];

/** A tiny seeded generator, so the sample is the same every time. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
const row = (cells: Array<string | number>) => cells.map(q).join(",");
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const isoAt = (d: Date, h: number, m = 0) => `${isoDay(d)}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;

export interface SampleFile {
  name: string;
  text: string;
}

/** The sample's files, dated back from `today`. */
export function sampleAmazonExport(today = new Date()): SampleFile[] {
  const r = rng(20261108);
  const day = (back: number) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back));
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];

  // Orders: about two a month, busier before Christmas, one or two items each.
  const orders: string[] = [row(["Website", "Order ID", "Order Date", "Currency", "Unit Price", "Total Owed", "ASIN", "Quantity", "Order Status", "Shipment Status", "Ship Date", "Shipping Address", "Payment Instrument Type", "Product Name"])];
  const returns: string[] = [row(["OrderID", "ReversalID", "RefundCompletionDate", "Currency", "AmountRefunded", "ReversalReason"])];
  let n = 0;
  for (let back = 700; back > 1; back -= 6 + Math.floor(r() * 14)) {
    const d = day(back);
    const xmas = d.getUTCMonth() === 10 || d.getUTCMonth() === 11;
    const count = xmas && r() < 0.5 ? 2 : 1;
    for (let k = 0; k < count; k++) {
      n++;
      const id = `204-${String(1000000 + n * 7919).slice(-7)}-${String(2000000 + n * 104729).slice(-7)}`;
      const items = 1 + (r() < 0.3 ? 1 : 0);
      const shipped = day(back - 1);
      const status = r() < 0.04 ? "Cancelled" : back < 4 ? "New" : "Closed";
      for (let i = 0; i < items; i++) {
        const [name, price] = pick(ORDERS);
        const qty = r() < 0.15 ? 2 : 1;
        const asin = `B0S${String(ORDERS.findIndex((o) => o[0] === name)).padStart(2, "0")}${n}`.slice(0, 10).padEnd(10, "X");
        orders.push(row(["Amazon.co.uk", id, isoAt(d, 8 + Math.floor(r() * 13), Math.floor(r() * 60)), "GBP", price.toFixed(2), (price * qty).toFixed(2), asin, qty, status, status === "Cancelled" ? "Not Available" : "Shipped", status === "Cancelled" ? "Not Available" : isoAt(shipped, 6), "1 Sample Street", "Visa - 0000", name]));
        if (status === "Closed" && i === 0 && r() < 0.08) returns.push(row([id, `R${n}`, isoAt(day(Math.max(2, back - 9)), 10), "GBP", (price * qty).toFixed(2), "CR-UNWANTED"]));
      }
    }
  }

  const digital = [row(["ASIN", "Title", "OrderId", "DigitalOrderItemId", "OrderDate", "FulfilledDate", "OurPrice", "OurPriceCurrencyCode", "Marketplace"])];
  const kindle = [row(["start_timestamp", "end_timestamp", "ASIN", "total_reading_millis", "number_of_page_flips", "content_type"])];
  const finished = [row(["ASIN", "Title", "Author", "Finished Date"])];
  // One book at a time, read in the evenings for a few weeks each.
  let back = 640;
  BOOKS.forEach(([asin, title, author], b) => {
    digital.push(row([asin, title, `D01-${1000000 + b}-${2000000 + b}`, `DI${b}`, isoAt(day(back + 1), 19), isoAt(day(back + 1), 19), (3.99 + b).toFixed(2), "GBP", "Amazon.co.uk"]));
    const span = 18 + Math.floor(r() * 20);
    for (let i = 0; i < span; i++) {
      if (r() < 0.35) continue;
      const mins = 12 + Math.floor(r() * 45);
      kindle.push(row([isoAt(day(back - i), 21, Math.floor(r() * 50)), isoAt(day(back - i), 22), asin, mins * 60_000, mins, "EBOOK"]));
    }
    if (b < BOOKS.length - 1) finished.push(row([asin, title, author, isoDay(day(back - span))]));
    back -= span + 60 + Math.floor(r() * 50);
  });

  const audible = [row(["Start Date", "End Date", "Start Position Milliseconds", "End Position Milliseconds", "Event Duration Milliseconds", "Product Name", "Asin", "Book Length Milliseconds"])];
  back = 520;
  for (const [asin, title, , length] of LISTENS) {
    let pos = 0;
    const total = length * 60_000;
    while (pos < total && back > 2) {
      const mins = 25 + Math.floor(r() * 40);
      const end = Math.min(total, pos + mins * 60_000);
      audible.push(row([`${isoDay(day(back))} 08:${String(Math.floor(r() * 50)).padStart(2, "0")}:00`, `${isoDay(day(back))} 09:30:00`, pos, end, end - pos, title, asin, total]));
      pos = end;
      back -= r() < 0.7 ? 1 : 2;
    }
    back -= 40;
  }

  const prime = [row(["Playback Start Datetime (UTC)", "Title", "Episode Name", "Season Number", "Seconds Viewed", "Video Type", "ASIN"])];
  back = 600;
  for (const [show, season, eps] of SHOWS) {
    eps.forEach((ep, i) => {
      prime.push(row([`${isoDay(day(back))} 20:${String(10 + i).padStart(2, "0")}:00`, `${show}: Season ${season}`, ep, season, 2400 + Math.floor(r() * 900), "Episode", `B0P${show.length}${season}${i}`.padEnd(10, "0")]));
      back -= r() < 0.5 ? 1 : 3;
    });
    back -= 90;
  }
  FILMS.forEach((film, i) => prime.push(row([`${isoDay(day(560 - i * 130))} 19:30:00`, film, "", "", 6000 + i * 300, "Movie", `B0F${i}`.padEnd(10, "0")])));

  return [
    { name: "Retail.OrderHistory.1/Retail.OrderHistory.1.csv", text: orders.join("\n") },
    { name: "Retail.CustomerReturns.1.1/Retail.CustomerReturns.1.1.csv", text: returns.join("\n") },
    { name: "Digital-Ordering.1/Digital Items.csv", text: digital.join("\n") },
    { name: "Kindle.Devices.ReadingSession/Kindle.Devices.ReadingSession.csv", text: kindle.join("\n") },
    { name: "Kindle.ReadingInsights/Kindle.Finished.csv", text: finished.join("\n") },
    { name: "Audible.Listening/Audible.Listening.csv", text: audible.join("\n") },
    { name: "PrimeVideo.ViewingHistory/ViewingHistory.csv", text: prime.join("\n") },
  ];
}

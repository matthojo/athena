/**
 * upsert_metric keeps its value and metadata in plaintext, so it refuses a
 * metric whose name says it's a health or money figure: those have their
 * own tools, which seal what they keep (log_health, log_spending and
 * log_meter_reading in ./logging.ts). It goes by the name alone, so it's a
 * guard against the obvious, not a guarantee.
 */

// Whole words in the name ("bp", not the "bp" in "subproject").
const HEALTH_WORDS = new Set(["bmi", "bp", "bpm", "hr", "hrv", "kcal", "spo2", "vo2", "vo2max", "a1c", "fat", "pulse", "blood", "pressure", "steps", "symptom", "symptoms", "medication", "meds", "dose"]);
const MONEY_WORDS = new Set(["gbp", "usd", "eur", "debt", "loan", "pay", "paid", "payment", "rent", "mortgage", "tax", "bill", "bills", "price", "cost", "money", "cash", "pension"]);
// Anywhere in the name ("bodyweight", "monthly_spend").
const HEALTH_PARTS = ["weight", "heart", "glucose", "cholesterol", "insulin", "sleep", "calorie", "oxygen", "bodyfat", "workout"];
const MONEY_PARTS = ["spend", "spent", "balance", "salary", "income", "expense", "saving", "networth", "net_worth", "wealth", "invest", "budget", "wage", "earning", "revenue", "profit", "dividend"];

/** Which sealed area a metric name belongs in, or null for an ordinary metric. Pure. */
export function sensitiveMetric(name: string): "health" | "money" | null {
  const flat = name.toLowerCase();
  // snake_case, kebab-case, spaces and camelCase all split into words.
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((w) => HEALTH_WORDS.has(w)) || HEALTH_PARTS.some((p) => flat.includes(p))) return "health";
  if (words.some((w) => MONEY_WORDS.has(w)) || MONEY_PARTS.some((p) => flat.includes(p))) return "money";
  return null;
}

/** The input error upsert_metric answers with for a sensitive name, or null. Pure. */
export function metricNameProblem(name: string): string | null {
  const area = sensitiveMetric(name);
  if (area === "health") return `"${name}" looks like a health figure, and metrics are kept in plaintext. Use log_health instead: Athena seals what it keeps.`;
  if (area === "money") return `"${name}" looks like a money figure, and metrics are kept in plaintext. Use log_spending (or log_meter_reading for a meter) instead: Athena seals what they keep.`;
  return null;
}

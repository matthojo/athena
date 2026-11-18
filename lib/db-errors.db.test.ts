// A failed query's error holds the Postgres code and the constraint name, never the SQL or a parameter
// (security review M13). The driver's own error is "Failed query: <sql>\nparams: <params>".
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/db-errors.db.test.ts
// Skipped without ATHENA_TEST_DB_URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";

const SECRET = "sk-priya-shah-07700900123";

/** Everything a log line or an MCP reply could carry: the message, the stack and what console.error prints. */
const everything = (error: unknown) => `${(error as Error).message}\n${(error as Error).stack}\n${inspect(error, { depth: 6 })}\n${JSON.stringify(error)}`;

async function thrown(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the query to fail");
}

test("a failing query's error carries neither the SQL nor a parameter", { skip }, async () => {
  const { q, qRaw, tx, AthenaDbError, AthenaInputError, releaseReminder } = await import("./db");
  const key = `db-errors-test:${SECRET}`;
  await releaseReminder(key);
  try {
    for (const run of [q, qRaw]) {
      // A unique violation: Postgres's own detail would read "Key (key)=(…) already exists."
      await run(`INSERT INTO reminder_log (key) VALUES ($1)`, [key]);
      const dup = await thrown(() => run(`INSERT INTO reminder_log (key) VALUES ($1)`, [key]));
      assert.ok(dup instanceof AthenaDbError);
      assert.equal(dup.code, "23505", "callers can still tell a unique violation");
      assert.equal(dup.constraint, "reminder_log_pkey");
      assert.match(dup.message, /23505/);
      assert.match(dup.message, /reminder_log_pkey/);
      assert.doesNotMatch(everything(dup), /INSERT INTO|sk-priya|07700900123|params/i);
      assert.equal((dup as { cause?: unknown }).cause, undefined, "the driver's error isn't kept: logging an error prints its cause");
      await releaseReminder(key);

      // A syntax error and a bad cast: the SQL text and the value stay out too.
      const syntax = await thrown(() => run(`SELEC 1 WHERE $1 = 'x'`, [SECRET]));
      assert.equal((syntax as InstanceType<typeof AthenaDbError>).code, "42601");
      assert.doesNotMatch(everything(syntax), /SELEC 1|sk-priya/);
      const cast = await thrown(() => run(`SELECT $1::uuid`, [SECRET]));
      assert.equal((cast as InstanceType<typeof AthenaDbError>).code, "22P02");
      assert.doesNotMatch(everything(cast), /uuid|sk-priya/);
    }

    // tx: the driver's errors are rewritten the same way…
    const inTx = await thrown(() =>
      tx(async (run) => {
        await run(`INSERT INTO reminder_log (key) VALUES ($1)`, [key]);
        await run(`INSERT INTO reminder_log (key) VALUES ($1)`, [key]);
      }),
    );
    assert.ok(inTx instanceof AthenaDbError);
    assert.equal(inTx.constraint, "reminder_log_pkey");
    assert.doesNotMatch(everything(inTx), /INSERT INTO|sk-priya/);
    assert.deepEqual(await q(`SELECT key FROM reminder_log WHERE key = $1`, [key]), [], "and it rolled back");

    // …and what the callback itself throws passes through untouched.
    const own = await thrown(() =>
      tx(async () => {
        throw new AthenaInputError("Invalid 'kind'");
      }),
    );
    assert.ok(own instanceof AthenaInputError);
    assert.equal(own.message, "Invalid 'kind'");
  } finally {
    await releaseReminder(key);
  }
});

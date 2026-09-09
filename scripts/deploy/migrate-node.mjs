/**
 * Node port of scripts/deploy/migrate.sh, for hosts without the psql client.
 *
 * The shell script is the upstream original and stays the reference. This file
 * exists because the personal deployment applies migrations from a Windows
 * workstation against a managed Postgres, where installing the PostgreSQL client
 * tools just to run 130 files is friction with no payoff. No migration uses a
 * psql meta-command, so a plain driver can execute every one of them verbatim.
 *
 * Behavior is intentionally identical to the shell version:
 *   - one transaction per migration file, because several files depend on it:
 *     0035's ON COMMIT DROP scratch tables, and org.workspaces'
 *     DEFERRABLE INITIALLY DEFERRED foreign key, which is checked at commit so a
 *     circular insert order across two tables can succeed
 *   - already-applied files are skipped through the schema_migrations ledger
 *   - views are re-applied on every run and are not tracked
 *   - runtime role passwords are set afterwards, only for roles that exist
 *   - ADMIN_EMAILS is reconciled last
 *
 * Usage (same environment variables as the shell script):
 *   MIGRATION_DATABASE_URL=postgresql://... node scripts/deploy/migrate-node.mjs
 */
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(SCRIPT_DIR, "..", "..");

// `pg` is a backend dependency rather than a root one, so resolve it from there.
const require = createRequire(join(ROOT_DIR, "apps", "backend", "package.json"));

function loadPgClient() {
  try {
    return require("pg").Client;
  } catch {
    throw new Error(
      "Could not load 'pg'. Run `npm ci --prefix apps/backend` first, which is where this script resolves it from.",
    );
  }
}

function getDatabaseUrl() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (url === undefined || url.trim() === "") {
    throw new Error("Set MIGRATION_DATABASE_URL to the database owner connection string.");
  }

  return url.trim();
}

/**
 * Managed providers terminate TLS with certificates that chain to a public root,
 * so verification stays on. `sslmode=require` in the URL is honored by the
 * driver, but being explicit keeps behavior the same across driver versions.
 */
function createClient(ClientClass, databaseUrl) {
  const needsSsl = /[?&]sslmode=(require|verify-ca|verify-full)/.test(databaseUrl);
  return new ClientClass({
    connectionString: databaseUrl,
    ...(needsSsl ? { ssl: { rejectUnauthorized: true } } : {}),
  });
}

function listSqlFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function loadAppliedMigrations(client) {
  const result = await client.query("SELECT filename FROM schema_migrations");
  return new Set(result.rows.map((row) => row.filename));
}

/**
 * Applies one migration on a connection of its own.
 *
 * The fresh connection is the whole point, not incidental tidiness. Several
 * migrations declare helpers in `pg_temp`, the session-local temporary schema —
 * 0007, 0018 and 0027 each create `pg_temp.to_canonical_jsonb_timestamp` with
 * the same signature. The shell script runs a separate psql process per file, so
 * every file gets an empty `pg_temp` and every one of those CREATEs succeeds.
 * Reusing one connection across files keeps the first definition alive and makes
 * the second file fail with "function already exists with same argument types".
 * One session per file is what reproduces psql's behavior.
 *
 * The ledger row is written inside the migration's own transaction, which is
 * slightly stricter than the shell script: there, the INSERT is a separate psql
 * call after the commit, so a crash in between would re-run an applied file.
 */
async function applyMigration(createClient, migrationsDir, filename) {
  const sql = readFileSync(join(migrationsDir, filename), "utf8");
  const client = createClient();
  await client.connect();

  try {
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [filename],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${filename} failed: ${error.message}`, { cause: error });
    }
  } finally {
    await client.end();
  }
}

async function applyMigrations(client, createClient) {
  const migrationsDir = join(ROOT_DIR, "db", "migrations");
  const applied = await loadAppliedMigrations(client);
  console.log("Running migrations...");

  for (const filename of listSqlFiles(migrationsDir)) {
    if (applied.has(filename)) {
      console.log(`  Skipping ${filename} (already applied)`);
      continue;
    }

    console.log(`  Applying ${filename}`);
    await applyMigration(createClient, migrationsDir, filename);
  }
}

async function applyViews(client) {
  const viewsDir = join(ROOT_DIR, "db", "views");
  console.log("Applying views...");

  for (const filename of listSqlFiles(viewsDir)) {
    console.log(`  Applying ${filename}`);
    const sql = readFileSync(join(viewsDir, filename), "utf8");
    try {
      await client.query(sql);
    } catch (error) {
      throw new Error(`View ${filename} failed: ${error.message}`, { cause: error });
    }
  }
}

/**
 * Mirrors the shell script's `SELECT format(...) WHERE EXISTS(...)` + `\gexec`:
 * the password is only set for a role the migrations actually created, and the
 * value reaches the server through `format('%L', ...)` rather than string
 * concatenation.
 */
async function setRolePassword(client, roleName, password) {
  if (password === undefined || password.trim() === "") {
    return;
  }

  const statement = await client.query(
    `SELECT format('ALTER ROLE %I WITH PASSWORD %L', $1::text, $2::text) AS sql
     WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1::text)`,
    [roleName, password],
  );

  if (statement.rowCount === 0) {
    console.log(`  Role ${roleName} does not exist, skipping password`);
    return;
  }

  await client.query(statement.rows[0].sql);
  console.log(`  Password set for ${roleName}`);
}

async function reconcileBootstrapAdmins(client) {
  const adminEmails = process.env.ADMIN_EMAILS ?? "";
  console.log("Reconciling bootstrap admins...");

  await client.query("BEGIN");
  try {
    await client.query(`
      CREATE TEMP TABLE desired_bootstrap_admins (
        email TEXT PRIMARY KEY
      ) ON COMMIT DROP;
    `);
    await client.query(
      `INSERT INTO desired_bootstrap_admins (email)
       SELECT DISTINCT lower(btrim(raw_email))
       FROM regexp_split_to_table($1::text, ',') AS raw_email
       WHERE btrim(raw_email) <> ''`,
      [adminEmails],
    );
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM desired_bootstrap_admins WHERE position('@' IN email) = 0
        ) THEN
          RAISE EXCEPTION 'ADMIN_EMAILS contains one or more invalid email values';
        END IF;
      END
      $$;
    `);
    await client.query(`
      INSERT INTO auth.admin_users (email, granted_at, granted_by, revoked_at, note, source)
      SELECT email, now(), 'bootstrap:ADMIN_EMAILS', NULL, NULL, 'bootstrap'
      FROM desired_bootstrap_admins
      ON CONFLICT (email) DO UPDATE
      SET granted_at = now(),
          granted_by = EXCLUDED.granted_by,
          revoked_at = NULL,
          note = NULL,
          source = 'bootstrap'
      WHERE auth.admin_users.source = 'bootstrap'
        AND auth.admin_users.revoked_at IS NOT NULL;
    `);
    await client.query(`
      UPDATE auth.admin_users
      SET revoked_at = now()
      WHERE source = 'bootstrap'
        AND revoked_at IS NULL
        AND email NOT IN (SELECT email FROM desired_bootstrap_admins);
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(`Bootstrap admin reconciliation failed: ${error.message}`, { cause: error });
  }
}

async function main() {
  const ClientClass = loadPgClient();
  const databaseUrl = getDatabaseUrl();
  const newClient = () => createClient(ClientClass, databaseUrl);
  const client = newClient();
  await client.connect();

  try {
    await ensureLedger(client);
    await applyMigrations(client, newClient);
    await applyViews(client);

    console.log("Setting runtime role passwords...");
    await setRolePassword(client, "backend_app", process.env.BACKEND_DB_PASSWORD);
    await setRolePassword(client, "auth_app", process.env.AUTH_DB_PASSWORD);
    await setRolePassword(client, "reporting_readonly", process.env.REPORTING_DB_PASSWORD);

    await reconcileBootstrapAdmins(client);
    console.log("Migrations complete.");
  } finally {
    await client.end();
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

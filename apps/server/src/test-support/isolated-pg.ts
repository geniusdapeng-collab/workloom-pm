/** Pure configuration gate: never connects, creates a database or reads a default URL. */
export type PgTestEnvironment = Readonly<Record<string, string | undefined>>;
export interface IsolatedPgTestConfig {
  readonly ownerUrl: string;
  readonly appUrl: string;
  readonly gatewayUrl: string;
  readonly identity: Readonly<{ host: string; port: number; database: string }>;
  readonly users: Readonly<{ owner: string; app: string; gateway: string }>;
}

const URL_KEYS = ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"] as const;
type UrlKey = typeof URL_KEYS[number];
function fail(reason: string): never { throw new Error(`Isolated PostgreSQL test configuration refused: ${reason}`); }

function connection(env: PgTestEnvironment, name: UrlKey) {
  const raw = env[name];
  if (!raw || raw.trim() !== raw) fail(`${name} must be an explicit complete URL`);
  let url: URL;
  try { url = new URL(raw); }
  catch { return fail(`${name} is not a valid PostgreSQL URL`); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) fail(`${name} must use PostgreSQL`);
  // pg accepts routing options in query strings. Restrict these fixtures to one
  // unambiguous URL identity so a ?host/port/database option cannot redirect it.
  if (url.search || url.hash) fail(`${name} must not contain query options or a fragment`);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) fail(`${name} must use a loopback host`);
  if (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535) fail(`${name} needs an explicit valid port`);
  let database: string, username: string;
  try { database = decodeURIComponent(url.pathname.slice(1)); username = decodeURIComponent(url.username); }
  catch { return fail(`${name} contains an invalid encoded identity`); }
  if (!url.pathname.startsWith("/") || !database || /[\u0000-\u001f\u007f/\\]/u.test(database)
    || ["postgres", "template0", "template1"].includes(database.toLowerCase())) fail(`${name} needs an explicit non-system fixture database`);
  if (!username || /[\u0000-\u001f\u007f]/u.test(username)) fail(`${name} needs an explicit database role`);
  return { raw, host, port: Number(url.port), database, username };
}

/**
 * RUN_DB_TESTS requests execution; it does not authorize a customer database.
 * PM_TEST_DATABASE_ISOLATED=1 is a separate, explicit declaration by the test
 * operator that these URLs belong to a disposable CI service or isolated probe.
 * A port number alone cannot establish that declaration. Production and absent
 * configuration fail before any pool is created; callers must not turn failure
 * into a skip. This helper does not prove isolation of an arbitrarily mislabelled DB.
 */
export function requireIsolatedPgTestConfig(env: PgTestEnvironment = process.env): IsolatedPgTestConfig {
  if (env.RUN_DB_TESTS !== "1") fail("RUN_DB_TESTS=1 is required");
  if (env.PM_TEST_DATABASE_ISOLATED !== "1") fail("PM_TEST_DATABASE_ISOLATED=1 must explicitly authorize the isolated fixture");
  if (env.NODE_ENV !== "test") fail("NODE_ENV must be test, never production or an implicit deployment environment");
  const owner = connection(env, URL_KEYS[0]);
  const app = connection(env, URL_KEYS[1]);
  const gateway = connection(env, URL_KEYS[2]);
  for (const target of [app, gateway]) {
    if (target.host !== owner.host || target.port !== owner.port || target.database !== owner.database) {
      fail("owner, app and gateway must target the same loopback host, explicit port and database");
    }
  }
  if (new Set([owner.username, app.username, gateway.username]).size !== 3) fail("owner, app and gateway must use three distinct database roles");
  return Object.freeze({
    ownerUrl: owner.raw, appUrl: app.raw, gatewayUrl: gateway.raw,
    identity: Object.freeze({ host: owner.host, port: owner.port, database: owner.database }),
    users: Object.freeze({ owner: owner.username, app: app.username, gateway: gateway.username }),
  });
}

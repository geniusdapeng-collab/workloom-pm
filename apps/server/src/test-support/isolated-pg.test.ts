import { describe, expect, it } from "vitest";
import { requireIsolatedPgTestConfig, type PgTestEnvironment } from "./isolated-pg.js";

const configured = (host = "127.0.0.1", port = "59721", database = "workloom_ci"): Record<string, string | undefined> => {
  const connection = (username: string, protocol = "postgres:") => {
    const url = new URL("postgres://test-only-owner@127.0.0.1:59721/test-only-fixture");
    url.username = username; url.hostname = host; url.port = port; url.pathname = "/" + database; url.protocol = protocol;
    return url.href;
  };
  return {
    RUN_DB_TESTS: "1", PM_TEST_DATABASE_ISOLATED: "1", NODE_ENV: "test",
    DATABASE_URL: connection("fixture_owner"), DATABASE_APP_URL: connection("fixture_app", "postgresql:"), DATABASE_GATEWAY_URL: connection("fixture_gateway"),
  };
};
const rejected = (overrides: PgTestEnvironment) => expect(() => requireIsolatedPgTestConfig({ ...configured(), ...overrides })).toThrow("configuration refused");

describe("explicit isolated PostgreSQL test authorization (configuration only; no I/O)", () => {
  it.each(["5432", "55437", "59721"])("accepts an explicitly authorized disposable database on port %s", (port) => {
    expect(requireIsolatedPgTestConfig(configured("localhost", port)).identity).toEqual({ host: "localhost", port: Number(port), database: "workloom_ci" });
  });
  it.each(["127.0.0.1", "localhost", "[::1]"])("accepts coherent loopback host %s and encoded database identity", (host) => {
    const result = requireIsolatedPgTestConfig(configured(host, "59721", encodeURIComponent("隔离 fixture")));
    expect(result.identity.database).toBe("隔离 fixture");
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.identity)).toBe(true); expect(Object.isFrozen(result.users)).toBe(true);
  });
  it("does not treat the former approved port or default local URL as authorization", () => {
    const env = configured("localhost", "55437", "workloom"); delete env.PM_TEST_DATABASE_ISOLATED;
    expect(() => requireIsolatedPgTestConfig(env)).toThrow("explicitly authorize");
  });
  it.each([undefined, "0", "true", " 1", "1 "])("rejects missing or ambiguous isolation authorization %s", (flag) => rejected({ PM_TEST_DATABASE_ISOLATED: flag }));
  it.each([undefined, "0", "true"])("requires RUN_DB_TESTS=1 rather than silently enabling or skipping on %s", (flag) => rejected({ RUN_DB_TESTS: flag }));
  it.each([undefined, "development", "production", "PRODUCTION", "production "])("rejects a non-test deployment environment %s", (mode) => rejected({ NODE_ENV: mode }));
  it.each(["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"])("refuses missing %s without a default fallback", (key) => {
    expect(() => requireIsolatedPgTestConfig({ ...configured(), [key]: undefined })).toThrow(key);
  });
  it.each([
    "not-a-url", "http://owner@127.0.0.1:59721/workloom_ci", "mysql://owner@127.0.0.1:59721/workloom_ci",
    "postgres://owner@db.customer.example:59721/workloom_ci", "postgres://owner@192.0.2.1:59721/workloom_ci",
    "postgres://owner@localhost.customer.example:59721/workloom_ci", "postgres://owner@/workloom_ci",
    "postgres://owner@127.0.0.1/workloom_ci", "postgres://owner@127.0.0.1:0/workloom_ci", "postgres://owner@127.0.0.1:65536/workloom_ci",
    "postgres://owner@127.0.0.1:59721/", "postgres://owner@127.0.0.1:59721/postgres", "postgres://owner@127.0.0.1:59721/template1",
    "postgres://owner@127.0.0.1:59721/fixture%2Fcustomer", "postgres://owner@127.0.0.1:59721/fixture%00customer",
    "postgres://owner@127.0.0.1:59721/fixture%ZZ", "postgres://127.0.0.1:59721/workloom_ci",
    "postgres://owner@127.0.0.1:59721/workloom_ci?host=db.customer.example", "postgres://owner@127.0.0.1:59721/workloom_ci?port=5432",
    "postgres://owner@127.0.0.1:59721/workloom_ci?database=customer", "postgres://owner@127.0.0.1:59721/workloom_ci#customer",
  ])("refuses ambiguous, remote or maintenance destination %#", (url) => rejected({ DATABASE_URL: url }));
  it.each([
    { DATABASE_APP_URL: "postgres://fixture_app@localhost:59721/workloom_ci" },
    { DATABASE_GATEWAY_URL: "postgres://fixture_gateway@127.0.0.1:5432/workloom_ci" },
    { DATABASE_APP_URL: "postgres://fixture_app@127.0.0.1:59721/other_fixture" },
    { DATABASE_GATEWAY_URL: "postgres://fixture_gateway@127.0.0.1:59721/other_fixture" },
  ])("refuses a split owner/app/gateway destination %#", (overrides) => rejected(overrides));
  it.each([
    { DATABASE_APP_URL: "postgres://fixture_owner@127.0.0.1:59721/workloom_ci" },
    { DATABASE_GATEWAY_URL: "postgres://fixture_app@127.0.0.1:59721/workloom_ci" },
    { DATABASE_APP_URL: "postgres://fixture_%6fwner@127.0.0.1:59721/workloom_ci" },
    { DATABASE_GATEWAY_URL: "postgres://fixture_%61pp@127.0.0.1:59721/workloom_ci" },
  ])("refuses owner/app/gateway role reuse %#", (overrides) => rejected(overrides));
  it("does not mutate the process or input environment and never exposes URL credentials on failure", () => {
    const env = configured(); const before = { ...env }; const original = { ...process.env };
    requireIsolatedPgTestConfig(env);
    expect(env).toEqual(before); expect(process.env).toEqual(original);
    const sensitive = new URL("postgres://test-only-owner@db.customer.example:59721/workloom_ci");
    sensitive.password = "mock-test-only-do-not-echo";
    const sensitiveUrl = sensitive.href;
    let error: unknown;
    try { requireIsolatedPgTestConfig({ ...env, DATABASE_URL: sensitiveUrl }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(sensitiveUrl); expect(String(error)).not.toContain(sensitive.password);
  });
});

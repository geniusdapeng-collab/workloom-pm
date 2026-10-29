import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  AssistantAuthError,
  requireCsrf,
  verifyLaunchCode,
} from "./auth.js";

const originalPublicKey = process.env.WORKLOOM_LAUNCH_PUBLIC_KEY;
const originalPublicKeyB64 = process.env.WORKLOOM_LAUNCH_PUBLIC_KEY_B64;

afterEach(() => {
  if (originalPublicKey === undefined) delete process.env.WORKLOOM_LAUNCH_PUBLIC_KEY;
  else process.env.WORKLOOM_LAUNCH_PUBLIC_KEY = originalPublicKey;
  if (originalPublicKeyB64 === undefined) delete process.env.WORKLOOM_LAUNCH_PUBLIC_KEY_B64;
  else process.env.WORKLOOM_LAUNCH_PUBLIC_KEY_B64 = originalPublicKeyB64;
});

function launchCode(overrides: Record<string, unknown> = {}, now = 1_800_000_000) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  process.env.WORKLOOM_LAUNCH_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
  delete process.env.WORKLOOM_LAUNCH_PUBLIC_KEY_B64;
  const claims = {
    iss: "pengmanager",
    aud: "workloom-pm",
    sub: "pengmanager-owner",
    jti: "launch_0123456789abcdef",
    iat: now,
    nbf: now - 1,
    exp: now + 60,
    tenantId: "tenant-pm",
    workspaceId: "ws-aipm-demo",
    memberNo: "MEM-001",
    ...overrides,
  };
  const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = sign(null, Buffer.from(encoded, "utf8"), privateKey).toString("base64url");
  return { code: `${encoded}.${signature}`, now };
}

describe("assistant launch-code and CSRF authentication", () => {
  it("accepts a short-lived Ed25519 launch code from the configured issuer", () => {
    const { code, now } = launchCode();
    expect(verifyLaunchCode(code, now)).toMatchObject({
      iss: "pengmanager",
      aud: "workloom-pm",
      tenantId: "tenant-pm",
      workspaceId: "ws-aipm-demo",
      memberNo: "MEM-001",
    });
  });

  it("rejects expired, wrong-audience, overlong and tampered launch codes", () => {
    const expired = launchCode({ iat: 1_799_999_000, exp: 1_799_999_060 });
    expect(() => verifyLaunchCode(expired.code, expired.now)).toThrowError(/过期/);

    const wrongAudience = launchCode({ aud: "another-product" });
    expect(() => verifyLaunchCode(wrongAudience.code, wrongAudience.now)).toThrowError(/来源无效/);

    const overlong = launchCode({ exp: 1_800_000_000 + 300 });
    expect(() => verifyLaunchCode(overlong.code, overlong.now)).toThrowError(/有效期无效/);

    const valid = launchCode();
    const [claims, signature] = valid.code.split(".");
    const tampered = `${claims!.slice(0, -1)}x.${signature}`;
    expect(() => verifyLaunchCode(tampered, valid.now)).toThrowError(/签名无效|无法解析/);
  });

  it("requires matching double-submit CSRF values on writes", () => {
    const token = "a".repeat(64);
    const request = new Request("http://localhost/api/assistant/sessions", {
      method: "POST",
      headers: {
        cookie: `workloom_csrf=${token}`,
        "x-workloom-csrf": token,
      },
    });
    expect(() => requireCsrf(request)).not.toThrow();
    expect(() => requireCsrf(new Request("http://localhost/api/assistant/sessions", {
      method: "POST",
      headers: { cookie: `workloom_csrf=${token}`, "x-workloom-csrf": "b".repeat(64) },
    }))).toThrowError(AssistantAuthError);
  });
});

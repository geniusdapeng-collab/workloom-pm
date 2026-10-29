import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { getOwnerPool } from "@workloom/db";
import {
  signDemoToken,
  verifySessionToken,
  type Identity,
} from "@workloom/base/tenancy";
import type { AssistantIdentity, AssistantLaunchClaims } from "./types.js";

const SESSION_SECONDS = 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 10;
const MAX_LAUNCH_LIFETIME_SECONDS = 120;

export class AssistantAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 401,
  ) {
    super(message);
    this.name = "AssistantAuthError";
  }
}

function production(): boolean {
  return process.env.NODE_ENV === "production";
}

export function assistantCookieNames(): { session: string; csrf: string } {
  return production()
    ? { session: "__Host-workloom_session", csrf: "__Host-workloom_csrf" }
    : { session: "workloom_session", csrf: "workloom_csrf" };
}

export function parseCookies(header: string | null | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key || !value) continue;
    try { cookies.set(key, decodeURIComponent(value)); }
    catch { /* Malformed cookie values are ignored and fail authentication. */ }
  }
  return cookies;
}

export function getSessionToken(request: Request): string | null {
  const cookie = parseCookies(request.headers.get("cookie")).get(assistantCookieNames().session);
  if (cookie) return cookie;
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
}

export async function resolveAssistantIdentity(request: Request): Promise<AssistantIdentity> {
  const token = getSessionToken(request);
  if (!token) throw new AssistantAuthError("UNAUTHENTICATED", "请从鹏经理后台重新进入 AI 研发中心");
  const session = await verifySessionToken(token);
  if (!session || session.kind === "partner") {
    throw new AssistantAuthError("SESSION_INVALID", "会话已失效，请从鹏经理后台重新进入");
  }
  return {
    ...session,
    assistantScope: {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId,
      memberNo: session.memberNo,
    },
  };
}

function launchPublicKey(): ReturnType<typeof createPublicKey> {
  const pem = process.env.WORKLOOM_LAUNCH_PUBLIC_KEY?.trim();
  const encoded = process.env.WORKLOOM_LAUNCH_PUBLIC_KEY_B64?.trim();
  if (!pem && !encoded) {
    throw new AssistantAuthError("LAUNCH_VERIFIER_NOT_CONFIGURED", "云端登录公钥尚未配置", 503);
  }
  try {
    if (pem) return createPublicKey(pem);
    return createPublicKey(Buffer.from(encoded!, "base64"));
  } catch {
    throw new AssistantAuthError("LAUNCH_VERIFIER_INVALID", "云端登录公钥配置无效", 503);
  }
}

function parseClaims(value: unknown, now: number): AssistantLaunchClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssistantAuthError("LAUNCH_CODE_INVALID", "登录入口格式无效");
  }
  const claim = value as Record<string, unknown>;
  const string = (key: string) => typeof claim[key] === "string" ? claim[key] as string : "";
  const number = (key: string) => typeof claim[key] === "number" && Number.isSafeInteger(claim[key])
    ? claim[key] as number : Number.NaN;
  const out: AssistantLaunchClaims = {
    iss: string("iss") as AssistantLaunchClaims["iss"],
    aud: string("aud") as AssistantLaunchClaims["aud"],
    sub: string("sub"),
    jti: string("jti"),
    iat: number("iat"),
    ...(claim.nbf !== undefined ? { nbf: number("nbf") } : {}),
    exp: number("exp"),
    tenantId: string("tenantId"),
    workspaceId: string("workspaceId"),
    memberNo: string("memberNo"),
  };
  if (out.iss !== "pengmanager" || out.aud !== "workloom-pm" || !out.sub || !out.jti
    || !/^[A-Za-z0-9_.:-]{16,200}$/.test(out.jti)
    || !out.tenantId || !out.workspaceId || !out.memberNo) {
    throw new AssistantAuthError("LAUNCH_CODE_INVALID", "登录入口声明不完整或来源无效");
  }
  if (!Number.isSafeInteger(out.iat) || !Number.isSafeInteger(out.exp)
    || out.exp <= out.iat || out.exp - out.iat > MAX_LAUNCH_LIFETIME_SECONDS
    || (out.nbf !== undefined && !Number.isSafeInteger(out.nbf))) {
    throw new AssistantAuthError("LAUNCH_CODE_INVALID", "登录入口有效期无效");
  }
  if (out.iat > now + CLOCK_SKEW_SECONDS || out.exp < now - CLOCK_SKEW_SECONDS
    || (out.nbf !== undefined && out.nbf > now + CLOCK_SKEW_SECONDS)) {
    throw new AssistantAuthError("LAUNCH_CODE_EXPIRED", "登录入口已过期，请从鹏经理后台重新进入");
  }
  return out;
}

export function verifyLaunchCode(code: string, nowSeconds = Math.floor(Date.now() / 1000)): AssistantLaunchClaims {
  if (!code || code.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(code)) {
    throw new AssistantAuthError("LAUNCH_CODE_INVALID", "登录入口格式无效");
  }
  const [encodedClaims, encodedSignature] = code.split(".");
  let claims: unknown;
  let signature: Buffer;
  try {
    claims = JSON.parse(Buffer.from(encodedClaims!, "base64url").toString("utf8"));
    signature = Buffer.from(encodedSignature!, "base64url");
  } catch {
    throw new AssistantAuthError("LAUNCH_CODE_INVALID", "登录入口无法解析");
  }
  const valid = verifySignature(null, Buffer.from(encodedClaims!, "utf8"), launchPublicKey(), signature);
  if (!valid) throw new AssistantAuthError("LAUNCH_CODE_INVALID", "登录入口签名无效");
  return parseClaims(claims, nowSeconds);
}

export async function issueAssistantSession(claims: AssistantLaunchClaims): Promise<{
  token: string;
  identity: Identity;
}> {
  const row = await getOwnerPool().query<{
    id: string;
    member_no: string;
    name: string;
    role: Identity["role"];
    tenant_id: string;
    workspace_id: string;
    plan: Identity["plan"];
  }>(
    `SELECT m.id,m.member_no,m.name,m.role,w.tenant_id,w.id AS workspace_id,t.plan
       FROM members m
       JOIN workspaces w ON w.id=m.workspace_id
       JOIN tenants t ON t.id=w.tenant_id
      WHERE w.id=$1 AND w.tenant_id=$2 AND m.member_no=$3
        AND t.status='active'
      LIMIT 1`,
    [claims.workspaceId, claims.tenantId, claims.memberNo],
  );
  const member = row.rows[0];
  if (!member) {
    throw new AssistantAuthError(
      "LAUNCH_IDENTITY_NOT_FOUND",
      "鹏经理管理员尚未映射到有效的 WorkLoom 成员",
      403,
    );
  }
  const identity: Identity = {
    memberId: member.id,
    memberNo: member.member_no,
    name: member.name,
    role: member.role,
    tenantId: member.tenant_id,
    workspaceId: member.workspace_id,
    plan: member.plan,
  };
  return { token: await signDemoToken(identity), identity };
}

export function createCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

export function sessionCookie(token: string): string {
  const name = assistantCookieNames().session;
  const secure = production() ? "; Secure" : "";
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure}`;
}

export function csrfCookie(token: string): string {
  const name = assistantCookieNames().csrf;
  const secure = production() ? "; Secure" : "";
  return `${name}=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure}`;
}

export function clearAssistantCookies(): string[] {
  const names = assistantCookieNames();
  const secure = production() ? "; Secure" : "";
  return [
    `${names.session}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
    `${names.csrf}=; Path=/; SameSite=Lax; Max-Age=0${secure}`,
  ];
}

export function csrfTokenForRequest(request: Request): string {
  return parseCookies(request.headers.get("cookie")).get(assistantCookieNames().csrf) ?? "";
}

export function requireCsrf(request: Request): void {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
  const cookie = csrfTokenForRequest(request);
  const header = request.headers.get("x-workloom-csrf")?.trim() ?? "";
  if (!cookie || !header) throw new AssistantAuthError("CSRF_REQUIRED", "缺少同源写入令牌", 403);
  const a = Buffer.from(cookie);
  const b = Buffer.from(header);
  if (a.length !== b.length || a.length < 32 || !a.equals(b)) {
    throw new AssistantAuthError("CSRF_INVALID", "同源写入令牌无效", 403);
  }
}

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const configured = (process.env.ASSISTANT_PUBLIC_ORIGIN ?? "").replace(/\/+$/, "");
  const requestOrigin = new URL(request.url).origin.replace(/\/+$/, "");
  const webPort = process.env.WEB_PORT ?? "5373";
  const allowed = new Set(
    [configured, requestOrigin, `http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`,
      "http://127.0.0.1:5173", "http://localhost:5173", "https://pm.pengmanager.com"]
      .filter(Boolean),
  );
  if (!allowed.has(origin.replace(/\/+$/, ""))) {
    throw new AssistantAuthError("ORIGIN_FORBIDDEN", "请求来源不在工作台白名单", 403);
  }
}

export function sessionIdentityFingerprint(identity: Identity): string {
  return createHash("sha256")
    .update(`${identity.tenantId}\0${identity.workspaceId}\0${identity.memberNo}`)
    .digest("hex")
    .slice(0, 16);
}

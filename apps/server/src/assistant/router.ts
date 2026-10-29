import { Hono } from "hono";
import { z, ZodError } from "zod";
import {
  AssistantAuthError,
  clearAssistantCookies,
  createCsrfToken,
  csrfCookie,
  csrfTokenForRequest,
  issueAssistantSession,
  requireCsrf,
  requireSameOrigin,
  resolveAssistantIdentity,
  sessionCookie,
  verifyLaunchCode,
} from "./auth.js";
import { AssistantModelError } from "./model.js";
import { AssistantStoreError } from "./store.js";
import { AssistantService } from "./service.js";
import type { AssistantIdentity } from "./types.js";
import { currentMemberAuthority } from "../service/access-authority.js";

const MAX_BODY_BYTES = 256 * 1024;
const SessionId = z.string().min(1).max(80).regex(/^as-[A-Za-z0-9-]+$/);
const RunId = z.string().min(1).max(80).regex(/^ar-[A-Za-z0-9-]+$/);
const ClientMessageId = z.string().min(8).max(160).regex(/^[A-Za-z0-9_.:-]+$/);

const CreateSession = z.object({
  title: z.string().trim().min(1).max(160).optional(),
}).strict();
const PatchSession = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  pinned: z.boolean().optional(),
}).strict().refine((value) => value.title !== undefined || value.pinned !== undefined, "至少修改一个字段");
const SendMessage = z.object({
  clientMessageId: ClientMessageId,
  text: z.string().trim().min(1).max(32_000),
  mode: z.enum(["ask", "task"]).default("ask"),
}).strict();
const ArchiveSession = z.object({
  archived: z.boolean(),
}).strict();
const ExchangeLaunch = z.object({
  code: z.string().min(20).max(8192),
}).strict();

interface Variables {
  assistantIdentity: AssistantIdentity;
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new AssistantStoreError("BODY_TOO_LARGE", "请求超过 256KiB 上限", 413);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AssistantStoreError("INVALID_JSON", "请求正文为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new AssistantStoreError("BODY_TOO_LARGE", "请求超过 256KiB 上限", 413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AssistantStoreError("INVALID_JSON", "请求必须是合法 JSON", 400);
  }
}

function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof ZodError) {
    return Response.json({
      error: {
        code: "INVALID_INPUT",
        message: "请求字段不符合工作台合同",
        fields: error.issues.map((issue) => issue.path.join(".")),
        requestId,
      },
    }, { status: 400 });
  }
  if (error instanceof AssistantAuthError) {
    return Response.json({ error: { code: error.code, message: error.message, requestId } }, {
      status: error.httpStatus as 400,
      headers: { "cache-control": "no-store" },
    });
  }
  if (error instanceof AssistantStoreError || error instanceof AssistantModelError) {
    return Response.json({ error: { code: error.code, message: error.message, requestId } }, {
      status: error.httpStatus as 400,
      headers: { "cache-control": "no-store" },
    });
  }
  console.error(`[assistant] request failed requestId=${requestId}`);
  return Response.json({
    error: {
      code: "ASSISTANT_INTERNAL_ERROR",
      message: `工作台内部错误，未宣称任务成功（requestId=${requestId}）`,
      requestId,
    },
  }, { status: 500, headers: { "cache-control": "no-store" } });
}

function queryAllowed(request: Request, allowed: string[]): URLSearchParams {
  const query = new URL(request.url).searchParams;
  const seen = new Set<string>();
  for (const key of query.keys()) {
    if (!allowed.includes(key) || seen.has(key)) {
      throw new AssistantStoreError("INVALID_QUERY", "查询包含不支持或重复的参数", 400);
    }
    seen.add(key);
  }
  return query;
}

const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(identity: AssistantIdentity, key: string, limit: number): void {
  const bucketKey = `${identity.assistantScope.tenantId}:${identity.assistantScope.workspaceId}:${identity.memberNo}:${key}`;
  const now = Date.now();
  const bucket = buckets.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + 60_000 });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) throw new AssistantStoreError("RATE_LIMITED", "请求过于频繁，请稍后再试", 429);
}

export interface AssistantRouterOptions {
  service?: AssistantService;
  authority?: typeof currentMemberAuthority;
}

export function createAssistantRouter(options: AssistantRouterOptions = {}) {
  const service = options.service ?? new AssistantService();
  const authority = options.authority ?? currentMemberAuthority;
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    context.header("x-content-type-options", "nosniff");
    context.header("referrer-policy", "same-origin");
    await next();
  });

  app.get("/health", (context) => context.json({
    ...service.status(),
    service: "workloom-pm-assistant",
  }));

  app.post("/auth/exchange", async (context) => {
    const requestId = crypto.randomUUID();
    try {
      requireSameOrigin(context.req.raw);
      const body = ExchangeLaunch.parse(await readJson(context.req.raw));
      const claims = verifyLaunchCode(body.code);
      await service.consumeLaunchNonce(claims);
      const session = await issueAssistantSession(claims);
      const csrf = createCsrfToken();
      context.header("set-cookie", sessionCookie(session.token));
      context.header("set-cookie", csrfCookie(csrf), { append: true });
      return context.json({
        ok: true,
        identity: {
          memberNo: session.identity.memberNo,
          name: session.identity.name,
          role: session.identity.role,
          workspaceId: session.identity.workspaceId,
        },
        csrfToken: csrf,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        requestId,
      });
    } catch (error) {
      return errorResponse(error, requestId);
    }
  });

  if (process.env.NODE_ENV !== "production") {
    app.post("/auth/dev-cookie", async (context) => {
      const requestId = crypto.randomUUID();
      try {
        requireSameOrigin(context.req.raw);
        const identity = await resolveAssistantIdentity(context.req.raw);
        const current = await authority(identity);
        const refreshed: AssistantIdentity = {
          ...current.identity,
          assistantScope: {
            tenantId: current.identity.tenantId,
            workspaceId: current.identity.workspaceId,
            memberNo: current.identity.memberNo,
          },
        };
        const authorization = context.req.header("authorization");
        if (!authorization?.startsWith("Bearer ")) {
          throw new AssistantAuthError("DEV_TOKEN_REQUIRED", "本地开发登录需要 Bearer 会话", 401);
        }
        const csrf = createCsrfToken();
        context.header("set-cookie", sessionCookie(authorization.slice(7).trim()));
        context.header("set-cookie", csrfCookie(csrf), { append: true });
        return context.json({
          ok: true,
          memberNo: refreshed.memberNo,
          name: refreshed.name,
          csrfToken: csrf,
          requestId,
        });
      } catch (error) {
        return errorResponse(error, requestId);
      }
    });
  }

  app.use("*", async (context, next) => {
    const requestId = crypto.randomUUID();
    try {
      requireSameOrigin(context.req.raw);
      const authenticated = await resolveAssistantIdentity(context.req.raw);
      const current = await authority(authenticated);
      const identity: AssistantIdentity = {
        ...current.identity,
        assistantScope: {
          tenantId: current.identity.tenantId,
          workspaceId: current.identity.workspaceId,
          memberNo: current.identity.memberNo,
        },
      };
      requireCsrf(context.req.raw);
      context.set("assistantIdentity", identity);
      await next();
    } catch (error) {
      return errorResponse(error, requestId);
    }
  });

  app.get("/auth/me", (context) => {
    const identity = context.get("assistantIdentity");
    return context.json({
      authenticated: true,
      memberNo: identity.memberNo,
      name: identity.name,
      role: identity.role,
      workspaceId: identity.workspaceId,
      csrfToken: csrfTokenForRequest(context.req.raw),
      status: service.status(),
    });
  });

  app.post("/auth/logout", (context) => {
    const cookies = clearAssistantCookies();
    context.header("set-cookie", cookies[0]!);
    context.header("set-cookie", cookies[1]!, { append: true });
    return context.json({ ok: true });
  });

  app.get("/sessions", async (context) => {
    const requestId = crypto.randomUUID();
    try {
      const query = queryAllowed(context.req.raw, ["query", "archived", "limit"]);
      const identity = context.get("assistantIdentity");
      const limit = z.coerce.number().int().min(1).max(100).parse(query.get("limit") ?? 50);
      const archived = query.get("archived") === "true";
      return context.json({
        sessions: await service.listSessions(identity, {
          query: query.get("query")?.slice(0, 200),
          archived,
          limit,
        }),
        requestId,
      });
    } catch (error) {
      return errorResponse(error, requestId);
    }
  });

  app.post("/sessions", async (context) => {
    const requestId = crypto.randomUUID();
    try {
      const identity = context.get("assistantIdentity");
      rateLimit(identity, "session-create", 30);
      const input = CreateSession.parse(await readJson(context.req.raw));
      return context.json(await service.createSession(identity, input.title), 201);
    } catch (error) {
      return errorResponse(error, requestId);
    }
  });

  app.patch("/sessions/:id", async (context) => {
    const requestId = crypto.randomUUID();
    try {
      const input = PatchSession.parse(await readJson(context.req.raw));
      return context.json(await service.updateSession(
        context.get("assistantIdentity"),
        SessionId.parse(context.req.param("id")),
        input,
      ));
    } catch (error) {
      return errorResponse(error, requestId);
    }
  });

  app.post("/sessions/:id/archive", async (context) => {
    const requestId = crypto.randomUUID();
    try {
      const input = ArchiveSession.parse(await readJson(context.req.raw));
      return context.json(await service.archiveSession(
        context.get("assistantIdentity"),
        SessionId.parse(context.req.param("id")),
        input.archived,
      ));
    } catch (error) {
      return errorResponse(error, requestId);
    }
  });

  app.delete("/sessions/:id", async (context) => {
    const requestId = crypto.randomUUID();
    try {
      return context.json(await service.deleteSession(
        context.get("assistantIdentity"),
        SessionId.parse(context.req.param("id")),
      ));
    } catch (error) {
      return errorResponse(error, requestId);
    }
  });

  app.get("/sessions/:id/messages", async (context) => {
    const requestId = crypto.randomUUID();
    try {
      const query = queryAllowed(context.req.raw, ["after"]);
      return context.json({
        messages: await service.listMessages(
          context.get("assistantIdentity"),
          SessionId.parse(context.req.param("id")),
          query.get("after") ?? "0",
        ),
      });
    } catch (error) {
      return errorResponse(error, requestId);
    }
  });

  app.post("/sessions/:id/messages", async (context) => {
    const requestId = crypto.randomUUID();
    try {
      const identity = context.get("assistantIdentity");
      rateLimit(identity, "message-send", 120);
      const input = SendMessage.parse(await readJson(context.req.raw));
      const turn = await service.send(identity, SessionId.parse(context.req.param("id")), input);
      return context.json({
        run: turn.run,
        userMessage: turn.userMessage,
        assistantMessage: turn.assistantMessage,
        replayed: turn.replayed,
      }, turn.replayed ? 200 : 202);
    } catch (error) {
      return errorResponse(error, requestId);
    }
  });

  app.get("/runs/:id", async (context) => {
    const requestId = crypto.randomUUID();
    try {
      const identity = context.get("assistantIdentity");
      return context.json(await service.evidence(identity, RunId.parse(context.req.param("id"))));
    } catch (error) {
      return errorResponse(error, requestId);
    }
  });

  app.get("/runs/:id/artifact", async (context) => {
    const requestId = crypto.randomUUID();
    try {
      const query = queryAllowed(context.req.raw, ["path"]);
      const path = z.string().min(1).max(220).parse(query.get("path"));
      return context.json(await service.artifact(
        context.get("assistantIdentity"),
        RunId.parse(context.req.param("id")),
        path,
      ));
    } catch (error) {
      return errorResponse(error, requestId);
    }
  });

  app.post("/runs/:id/stop", async (context) => {
    const requestId = crypto.randomUUID();
    try {
      return context.json(await service.stop(
        context.get("assistantIdentity"),
        RunId.parse(context.req.param("id")),
      ));
    } catch (error) {
      return errorResponse(error, requestId);
    }
  });

  app.post("/runs/:id/retry", async (context) => {
    const requestId = crypto.randomUUID();
    try {
      const identity = context.get("assistantIdentity");
      rateLimit(identity, "run-retry", 60);
      const turn = await service.retry(identity, RunId.parse(context.req.param("id")));
      return context.json({
        run: turn.run,
        userMessage: turn.userMessage,
        assistantMessage: turn.assistantMessage,
        replayed: turn.replayed,
      }, 202);
    } catch (error) {
      return errorResponse(error, requestId);
    }
  });

  app.get("/runs/:id/events", async (context) => {
    const requestId = crypto.randomUUID();
    try {
      const identity = context.get("assistantIdentity");
      const runId = RunId.parse(context.req.param("id"));
      const query = queryAllowed(context.req.raw, ["after"]);
      let lastId = context.req.header("last-event-id") || query.get("after") || "0";
      if (!/^\d{1,20}$/.test(lastId)) lastId = "0";
      const initial = await service.evidence(identity, runId);
      const encoder = new TextEncoder();
      const signal = context.req.raw.signal;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: string, data: unknown, id?: string) => {
            const prefix = id ? `id: ${id}\n` : "";
            controller.enqueue(encoder.encode(`${prefix}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            controller.close();
          };
          signal.addEventListener("abort", close, { once: true });
          try {
            send("snapshot", initial);
            let idleSince = Date.now();
            while (!closed && !signal.aborted) {
              const events = await service.getEvents(identity, runId, lastId);
              for (const event of events) {
                lastId = event.id;
                idleSince = Date.now();
                send(event.type, event.payload, event.id);
                if (event.type === "message.done") {
                  close();
                  break;
                }
              }
              if (closed) break;
              if (Date.now() - idleSince > 15_000) {
                send("heartbeat", { at: new Date().toISOString() });
                idleSince = Date.now();
              }
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          } catch (error) {
            if (!closed) {
              send("error", {
                code: error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "SSE_FAILED",
                message: error instanceof Error ? error.message.slice(0, 500) : "事件流中断",
                requestId,
              });
              close();
            }
          } finally {
            signal.removeEventListener("abort", close);
          }
        },
      });
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    } catch (error) {
      return errorResponse(error, requestId);
    }
  });

  app.onError((error, context) => errorResponse(error, crypto.randomUUID()));
  return app;
}

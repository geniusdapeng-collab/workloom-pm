export type AssistantMode = "ask" | "task";

export interface AssistantSession {
  id: string;
  title: string;
  status: "active" | "archived" | "deleted";
  pinned: boolean;
  lastMessageAt: string | null;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantPart {
  type: string;
  text?: string;
  url?: string;
  title?: string;
  runId?: string;
  status?: string;
  summary?: string;
  siteName?: string | null;
  publishedAt?: string | null;
  path?: string;
  sha256?: string;
  sizeBytes?: number;
  taskId?: string;
  code?: string;
  message?: string;
}

export interface AssistantMessage {
  id: string;
  seq: string;
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  parts: AssistantPart[];
  parentMessageId: string | null;
  clientMessageId: string | null;
  runId: string | null;
  status: "pending" | "streaming" | "completed" | "failed" | "cancelled";
  createdAt: string;
  finishedAt: string | null;
}

export interface AssistantRun {
  id: string;
  sessionId: string;
  mode: AssistantMode;
  model: string;
  responseModel: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "blocked";
  threadId: string | null;
  responseId: string | null;
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  webSearchRequested: boolean;
  searchStatus: "not_requested" | "searching" | "completed" | "empty" | "failed" | "blocked";
  searchQuery: string | null;
  searchResultCount: number;
  searchCompletedAt: string | null;
  errorCode: string | null;
  error: string | null;
  userMessageId: string;
  assistantMessageId: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantIdentity {
  memberNo: string;
  name: string;
  role: string;
  workspaceId: string;
}

export interface AssistantStatus {
  ok: boolean;
  model: string;
  modelConfigured: boolean;
  webSearchConfigured: boolean;
  webSearchDailyLimit: number;
  mode: string;
  persistence: string;
  streaming: string;
  externalActions: boolean;
  codeExecution: string;
}

export interface TaskEvidence {
  run: {
    id: string;
    status: string;
    goal: string;
    usage: { promptTokens: number; completionTokens: number };
    error: string | null;
    verification: Record<string, unknown> | null;
  };
  tasks: Array<{
    id: string;
    presetKey: string;
    status: string;
    summary: string | null;
    error: string | null;
  }>;
  artifacts: Array<{
    path: string;
    sha256: string;
    sizeBytes: number;
    taskId: string;
  }>;
}

export interface RunEvidence {
  run: AssistantRun;
  task: TaskEvidence | null;
  warning?: string;
}

export class AssistantApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AssistantApiError";
  }
}

let csrfToken = "";
export function setCsrfToken(value: string): void {
  csrfToken = value;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) headers.set("x-workloom-csrf", csrfToken);
  let response: Response;
  try {
    response = await fetch(`/api/assistant${path}`, {
      ...init,
      headers,
      credentials: "same-origin",
    });
  } catch {
    throw new AssistantApiError("NETWORK_ERROR", "无法连接研发工作台，请检查云端服务", 0);
  }
  const body = await response.json().catch(() => ({})) as {
    error?: { code?: string; message?: string };
    [key: string]: unknown;
  };
  if (!response.ok) {
    throw new AssistantApiError(
      body.error?.code ?? `HTTP_${response.status}`,
      body.error?.message ?? `请求失败（HTTP ${response.status}）`,
      response.status,
    );
  }
  return body as T;
}

export async function exchangeLaunch(code: string): Promise<{
  identity: AssistantIdentity;
  csrfToken: string;
  status: AssistantStatus;
}> {
  const result = await request<{
    identity: AssistantIdentity;
    csrfToken: string;
    status?: AssistantStatus;
  }>("/auth/exchange", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
  setCsrfToken(result.csrfToken);
  const me = await assistantMe();
  return { identity: result.identity, csrfToken: result.csrfToken, status: me.status };
}

export async function createDevCookie(token: string): Promise<{
  identity: AssistantIdentity;
  csrfToken: string;
}> {
  const result = await request<{
    memberNo: string;
    name: string;
    csrfToken: string;
  }>("/auth/dev-cookie", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  setCsrfToken(result.csrfToken);
  return {
    identity: {
      memberNo: result.memberNo,
      name: result.name,
      role: "owner",
      workspaceId: "",
    },
    csrfToken: result.csrfToken,
  };
}

export function assistantMe(): Promise<{
  authenticated: true;
  memberNo: string;
  name: string;
  role: string;
  workspaceId: string;
  csrfToken: string;
  status: AssistantStatus;
}> {
  return request("/auth/me").then((value) => {
    const result = value as ReturnType<typeof assistantMe> extends Promise<infer T> ? T : never;
    setCsrfToken(result.csrfToken);
    return result;
  });
}

export function logout(): Promise<{ ok: true }> {
  return request("/auth/logout", { method: "POST", body: "{}" });
}

export function listSessions(options: { query?: string; archived?: boolean } = {}): Promise<{ sessions: AssistantSession[] }> {
  const query = new URLSearchParams();
  if (options.query) query.set("query", options.query);
  if (options.archived) query.set("archived", "true");
  return request(`/sessions${query.size ? `?${query}` : ""}`);
}

export function createSession(title?: string): Promise<AssistantSession> {
  return request("/sessions", {
    method: "POST",
    body: JSON.stringify(title ? { title } : {}),
  });
}

export function updateSession(id: string, patch: { title?: string; pinned?: boolean }): Promise<AssistantSession> {
  return request(`/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function archiveSession(id: string, archived: boolean): Promise<AssistantSession> {
  return request(`/sessions/${encodeURIComponent(id)}/archive`, {
    method: "POST",
    body: JSON.stringify({ archived }),
  });
}

export function deleteSession(id: string): Promise<AssistantSession> {
  return request(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function listMessages(sessionId: string): Promise<{ messages: AssistantMessage[] }> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/messages`);
}

export function sendMessage(sessionId: string, input: {
  text: string;
  mode: AssistantMode;
  webSearch: boolean;
  clientMessageId: string;
}): Promise<{
  run: AssistantRun;
  userMessage: AssistantMessage;
  assistantMessage: AssistantMessage;
  replayed: boolean;
}> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getRun(runId: string): Promise<RunEvidence> {
  return request(`/runs/${encodeURIComponent(runId)}`);
}

export function stopRun(runId: string): Promise<AssistantRun> {
  return request(`/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", body: "{}" });
}

export function retryRun(runId: string): Promise<{
  run: AssistantRun;
  userMessage: AssistantMessage;
  assistantMessage: AssistantMessage;
}> {
  return request(`/runs/${encodeURIComponent(runId)}/retry`, { method: "POST", body: "{}" });
}

export function getArtifact(runId: string, path: string): Promise<{
  path: string;
  content: string;
  sha256: string;
  mediaType: string;
  sizeBytes: number;
  taskId: string;
}> {
  return request(`/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(path)}`);
}

const EVENT_TYPES = [
  "snapshot",
  "message.start",
  "search.started",
  "search.completed",
  "message.delta",
  "task.updated",
  "artifact.created",
  "usage.updated",
  "error",
  "message.done",
  "heartbeat",
] as const;

export type AssistantStreamEventName = typeof EVENT_TYPES[number];

export function streamRunEvents(
  runId: string,
  handlers: {
    onEvent: (event: AssistantStreamEventName, data: Record<string, unknown>, id: string) => void;
    onError: (error: Event) => void;
  },
): () => void {
  const source = new EventSource(`/api/assistant/runs/${encodeURIComponent(runId)}/events`);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
  };
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (event) => {
      const message = event as MessageEvent<string>;
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(message.data) as Record<string, unknown>; }
      catch { data = { message: message.data }; }
      if (!closed) handlers.onEvent(type, data, message.lastEventId);
      if (type === "message.done") close();
    });
  }
  source.onerror = (event) => {
    if (!closed) handlers.onError(event);
  };
  return close;
}

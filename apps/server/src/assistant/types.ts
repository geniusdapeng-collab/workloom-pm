import type { Identity } from "@workloom/base/tenancy";

export interface AssistantScope {
  tenantId: string;
  workspaceId: string;
  memberNo: string;
}

export type AssistantMode = "ask" | "task";
export type AssistantSessionStatus = "active" | "archived" | "deleted";
export type AssistantRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "blocked";

export type AssistantPart =
  | { type: "text"; text: string }
  | { type: "source"; title?: string; url: string; summary?: string; siteName?: string | null; publishedAt?: string | null }
  | { type: "task"; runId: string; status: string; summary?: string }
  | { type: "artifact"; path: string; sha256: string; sizeBytes: number; taskId: string }
  | { type: "warning"; code: string; message: string };

export type AssistantSearchStatus =
  | "not_requested"
  | "searching"
  | "completed"
  | "empty"
  | "failed"
  | "blocked";

export interface AssistantSearchSource {
  title: string;
  url: string;
  snippet: string;
  summary: string;
  siteName: string | null;
  publishedAt: string | null;
  authority: number;
  rerankScore: number | null;
}

export interface AssistantSearchReceipt {
  query: string;
  searchedAt: string;
  results: AssistantSearchSource[];
}

export interface AssistantSession {
  id: string;
  title: string;
  status: AssistantSessionStatus;
  pinned: boolean;
  lastMessageAt: string | null;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
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

export interface AssistantUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AssistantRun {
  id: string;
  sessionId: string;
  mode: AssistantMode;
  model: string;
  responseModel: string | null;
  status: AssistantRunStatus;
  threadId: string | null;
  responseId: string | null;
  usage: AssistantUsage;
  webSearchRequested: boolean;
  searchStatus: AssistantSearchStatus;
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

export interface AssistantRunEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AssistantLaunchClaims {
  iss: "pengmanager";
  aud: "workloom-pm";
  sub: "pengmanager-owner" | string;
  jti: string;
  iat: number;
  nbf?: number;
  exp: number;
  tenantId: string;
  workspaceId: string;
  memberNo: string;
}

export interface AssistantIdentity extends Identity {
  assistantScope: AssistantScope;
}

export interface AssistantEventSink {
  append(scope: AssistantScope, input: {
    sessionId: string;
    runId?: string;
    action: string;
    objectType: string;
    objectId: string;
    after: Record<string, unknown>;
    receipt?: Record<string, unknown>;
  }): Promise<void>;
}

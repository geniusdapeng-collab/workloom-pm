import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useAuiState,
  type AppendMessage,
  type TextMessagePartProps,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon, clientChineseText, clientStatusLabel } from "@workloom/ui";
import { actorText, shortId } from "../../lib/display";
import {
  AssistantApiError,
  archiveSession,
  assistantMe,
  createDevCookie,
  createSession,
  deleteSession,
  exchangeLaunch,
  getArtifact,
  getRun,
  listMessages,
  listSessions,
  logout,
  retryRun,
  sendMessage,
  setCsrfToken,
  stopRun,
  streamRunEvents,
  updateSession,
  type AssistantIdentity,
  type AssistantMessage,
  type AssistantMode,
  type AssistantPart,
  type AssistantRun,
  type AssistantSession,
  type AssistantStatus,
  type RunEvidence,
} from "./api";
import "./assistant.css";

type BootState = "loading" | "ready" | "unauthorized" | "error";

class ConversationBoundary extends Component<
  { children: ReactNode; resetKey: string | null },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[assistant-ui] 对话组件异常", error);
  }

  componentDidUpdate(previous: Readonly<{ children: ReactNode; resetKey: string | null }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="assistant-crash" role="alert">
          <strong>对话界面刚刚遇到一个显示问题</strong>
          <p>消息仍保存在云端。切换到另一个会话或刷新页面即可恢复。</p>
          <button type="button" onClick={() => this.setState({ failed: false })}>重新渲染</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function messageText(message: AssistantMessage): string {
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function appendText(message: AssistantMessage, delta: string): AssistantMessage {
  const text = messageText(message);
  return {
    ...message,
    status: "streaming",
    parts: [{ type: "text", text: `${text}${delta}` }],
  };
}

function runtimeMessage(message: AssistantMessage): ThreadMessageLike {
  const text = messageText(message);
  const status: ThreadMessageLike["status"] = message.role === "assistant"
    ? message.status === "streaming" || message.status === "pending"
      ? { type: "running" }
      : message.status === "completed"
        ? { type: "complete", reason: "stop" }
        : message.status === "cancelled"
          ? { type: "incomplete", reason: "cancelled" }
          : message.status === "failed"
            ? { type: "incomplete", reason: "error" }
            : undefined
    : undefined;
  return {
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    createdAt: new Date(message.createdAt),
    content: [{ type: "text", text: text || (message.status === "pending" ? "正在连接模型…" : "") }],
    ...(status ? { status } : {}),
    metadata: {
      custom: {
        runId: message.runId,
        persistedStatus: message.status,
        parts: message.parts as unknown as Record<string, unknown>,
      },
    },
  };
}

function appendTextFromParts(message: AppendMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function formatTime(value: string | null): string {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function modelName(value: string | null | undefined, fallback = "模型待确认"): string {
  if (!value) return fallback;
  if (/^deepseek(?:-flash)?$/i.test(value)) return "DeepSeek 极速模型";
  if (/^DeepSeek-[A-Za-z0-9._-]{1,120}$/.test(value)) return value;
  return clientChineseText(value, fallback);
}

function sandboxText(value: string | null | undefined): string {
  if (!value) return "待检测";
  return /linux|darwin|macos/i.test(value) ? "隔离代码沙箱" : "沙箱状态已记录";
}

function eventTypeText(value: string): string {
  const labels: Record<string, string> = {
    snapshot: "状态快照",
    "message.start": "开始生成",
    "search.started": "开始搜索网页",
    "search.completed": "网页搜索完成",
    "message.delta": "流式回答",
    "task.updated": "任务状态更新",
    "artifact.created": "产物已生成",
    "usage.updated": "用量已更新",
    error: "运行异常",
    "message.done": "回答完成",
    heartbeat: "连接保持",
  };
  return labels[value] ?? "运行事件";
}

function sessionGroup(session: AssistantSession): string {
  const value = session.lastMessageAt ?? session.createdAt;
  const date = new Date(value);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const stamp = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.floor((today - stamp) / 86_400_000);
  if (days <= 0) return "今天";
  if (days < 7) return "最近 7 天";
  return "更早";
}

function safeUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function inlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={`${keyPrefix}-c-${index++}`}>{token.slice(1, -1)}</code>);
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
      const url = safeUrl(link?.[2]);
      nodes.push(url
        ? <a key={`${keyPrefix}-a-${index++}`} href={url} target="_blank" rel="noreferrer">{link?.[1]}</a>
        : token);
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function MarkdownText({ text, status }: TextMessagePartProps) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let code: string[] | null = null;
  let codeLanguage = "";
  let paragraph: string[] = [];
  let list: Array<{ ordered: boolean; text: string }> = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(<p key={`p-${blocks.length}`}>{inlineMarkdown(paragraph.join(" "), `p-${blocks.length}`)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    const ordered = list[0]!.ordered;
    const items = list.map((item, index) => <li key={`li-${blocks.length}-${index}`}>{inlineMarkdown(item.text, `li-${blocks.length}-${index}`)}</li>);
    blocks.push(ordered
      ? <ol key={`list-${blocks.length}`}>{items}</ol>
      : <ul key={`list-${blocks.length}`}>{items}</ul>);
    list = [];
  };

  for (const line of lines) {
    const fence = /^```([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (fence) {
      if (code) {
        blocks.push(
          <pre key={`code-${blocks.length}`} data-language={codeLanguage || undefined}>
            <code>{code.join("\n")}</code>
          </pre>,
        );
        code = null;
        codeLanguage = "";
      } else {
        flushParagraph();
        flushList();
        code = [];
        codeLanguage = fence[1] ?? "";
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1]!.length;
      const content = inlineMarkdown(heading[2]!, `h-${blocks.length}`);
      blocks.push(level === 1
        ? <h1 key={`h-${blocks.length}`}>{content}</h1>
        : level === 2
          ? <h2 key={`h-${blocks.length}`}>{content}</h2>
          : level === 3
            ? <h3 key={`h-${blocks.length}`}>{content}</h3>
            : <h4 key={`h-${blocks.length}`}>{content}</h4>);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      list.push({ ordered: Boolean(ordered), text: (bullet?.[1] ?? ordered?.[1])! });
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    if (line.startsWith("> ")) {
      flushParagraph();
      flushList();
      blocks.push(<blockquote key={`q-${blocks.length}`}>{inlineMarkdown(line.slice(2), `q-${blocks.length}`)}</blockquote>);
      continue;
    }
    paragraph.push(line.trim());
  }
  if (code) blocks.push(<pre key={`code-${blocks.length}`}><code>{code.join("\n")}</code></pre>);
  flushParagraph();
  flushList();
  return (
    <div className="assistant-markdown">
      {blocks.length ? blocks : <p>{inlineMarkdown(text, "fallback")}</p>}
      {status?.type === "running" ? <span className="assistant-caret" aria-hidden="true" /> : null}
    </div>
  );
}

function SourcePart({ url, title, summary, siteName, publishedAt }: {
  url: string;
  title?: string;
  summary?: string;
  siteName?: string | null;
  publishedAt?: string | null;
}) {
  const safe = safeUrl(url);
  if (!safe) return null;
  return (
    <a className="assistant-source" href={safe} target="_blank" rel="noreferrer">
      <span>{siteName || "来源"}</span>
      <strong>{title || new URL(safe).hostname}</strong>
      {summary ? <small>{summary}</small> : null}
      {publishedAt ? <time dateTime={publishedAt}>{publishedAt.slice(0, 10)}</time> : null}
    </a>
  );
}

function PersistedStructuredParts({ onDownload }: { onDownload: (runId: string, path: string) => void }) {
  const custom = useAuiState((state) => state.message.metadata.custom) as {
    runId?: string | null;
    parts?: AssistantPart[];
  } | undefined;
  const parts = (custom?.parts ?? []).filter((part) => part.type !== "text");
  if (!parts.length) return null;
  return (
    <div className="assistant-structured-parts">
      {parts.map((part, index) => {
        if (part.type === "source") {
          return (
            <SourcePart
              key={`source-${index}`}
              url={part.url ?? ""}
              title={part.title}
              summary={part.summary}
              siteName={part.siteName}
              publishedAt={part.publishedAt}
            />
          );
        }
        if (part.type === "task") {
          return (
            <div className="assistant-message-card assistant-message-card--task" key={`task-${index}`}>
              <span>任务回执</span>
              <strong>{clientStatusLabel(part.status ?? "")}</strong>
              <small>{clientChineseText(part.summary, "任务状态已记录")}</small>
            </div>
          );
        }
        if (part.type === "artifact" && part.path && part.sha256) {
          return (
            <button
              type="button"
              className="assistant-message-card assistant-message-card--artifact"
              key={`artifact-${part.path}`}
              disabled={!custom?.runId}
              onClick={() => custom?.runId && onDownload(custom.runId, part.path!)}
            >
              <span>已校验产物</span>
              <strong>已验证产物文件</strong>
              <small>{part.sizeBytes ?? 0} 字节 · 点击下载</small>
            </button>
          );
        }
        if (part.type === "warning") {
          return (
            <div className="assistant-message-warning" key={`warning-${index}`} role="status">
              <strong>{clientChineseText(part.message, "运行提示已记录")}</strong>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function ConversationMessage({ onDownload }: { onDownload: (runId: string, path: string) => void }) {
  return (
    <MessagePrimitive.Root className="assistant-message" data-role="message">
      <MessagePrimitive.If user>
        <div className="assistant-message__meta"><span>你</span></div>
        <div className="assistant-message__bubble assistant-message__bubble--user">
          <MessagePrimitive.Parts />
        </div>
      </MessagePrimitive.If>
      <MessagePrimitive.If assistant>
        <div className="assistant-message__meta">
          <span className="assistant-agent-dot" aria-hidden="true" />
          <span>织元研发台</span>
        </div>
        <div className="assistant-message__bubble assistant-message__bubble--assistant">
          <MessagePrimitive.Parts
            components={{
              Text: MarkdownText,
              Empty: () => <span className="assistant-thinking">正在生成…</span>,
            }}
          />
          <PersistedStructuredParts onDownload={onDownload} />
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  );
}

function Conversation({
  messages,
  isRunning,
  mode,
  webSearch,
  webSearchConfigured,
  onModeChange,
  onToggleWebSearch,
  onSend,
  onStop,
  onOpenEvidence,
  onDownloadArtifact,
}: {
  messages: AssistantMessage[];
  isRunning: boolean;
  mode: AssistantMode;
  webSearch: boolean;
  webSearchConfigured: boolean;
  onModeChange: (mode: AssistantMode) => void;
  onToggleWebSearch: () => void;
  onSend: (text: string) => Promise<void>;
  onStop: () => Promise<void>;
  onOpenEvidence: () => void;
  onDownloadArtifact: (runId: string, path: string) => void;
}) {
  const runtime = useExternalStoreRuntime<AssistantMessage>({
    messages,
    isRunning,
    convertMessage: runtimeMessage,
    onNew: async (message) => {
      const text = appendTextFromParts(message);
      if (!text) throw new Error("请输入研发目标或问题");
      await onSend(text);
    },
    onCancel: onStop,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="assistant-thread">
        <ThreadPrimitive.Viewport className="assistant-thread__viewport" turnAnchor="bottom">
          <ThreadPrimitive.If empty>
            <div className="assistant-empty">
              <div className="assistant-empty__orb" aria-hidden="true"><span /></div>
              <p className="assistant-eyebrow">云端研发工作台</p>
              <h1>从一个真实目标开始</h1>
              <p>普通问答会调用真实 DeepSeek；研发任务会进入 14 岗位团队、依赖任务图和独立沙箱验收。</p>
              <div className="assistant-starters">
                {[
                  "帮我评审一个产品需求，指出风险并给出验收标准",
                  "把“做一个客户反馈模块”拆成研发任务",
                  "分析当前系统最可能拖慢交付的三个瓶颈",
                  "设计一套 200 条真实模型评测的检查方案",
                ].map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    onClick={() => {
                      runtime.thread.append(starter);
                    }}
                  >
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          </ThreadPrimitive.If>
          <ThreadPrimitive.Messages>{() => <ConversationMessage onDownload={onDownloadArtifact} />}</ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>

        <div className="assistant-composer-shell">
          <div className="assistant-modebar" role="group" aria-label="对话模式">
            <button
              type="button"
              className={mode === "ask" ? "is-active" : ""}
              onClick={() => onModeChange("ask")}
              disabled={isRunning}
            >
              <span>问</span> 真实问答
            </button>
            <button
              type="button"
              className={mode === "task" ? "is-active" : ""}
              onClick={() => onModeChange("task")}
              disabled={isRunning}
            >
              <span>派</span> 研发任务
            </button>
            <button
              type="button"
              className={webSearch ? "is-active" : ""}
              onClick={onToggleWebSearch}
              disabled={isRunning || !webSearchConfigured}
              aria-pressed={webSearch}
              title={webSearchConfigured ? "本轮先调用 DeepSeek Search，再结合真实来源回答" : "服务端未配置 DeepSeek 搜索凭据"}
            >
              <span>联</span> 联网搜索
            </button>
            <button type="button" className="assistant-evidence-toggle" onClick={onOpenEvidence}>
              运行证据
            </button>
          </div>
          <ComposerPrimitive.Root className="assistant-composer">
            <ComposerPrimitive.Input
              className="assistant-composer__input"
              placeholder={mode === "task" ? "描述一个可验收的研发目标；复杂任务会创建真实任务图…" : "输入问题，按回车发送，按住 Shift 再回车换行…"}
              rows={2}
              maxRows={8}
              submitMode="enter"
              aria-label="发送研发对话"
            />
            <div className="assistant-composer__actions">
              <span className="assistant-composer__hint">
                {mode === "task" ? "真实团队 · 围栏 · 沙箱" : "DeepSeek 极速模型 · 流式"}
                {webSearch ? " · 先搜索后回答" : ""}
              </span>
              <ComposerPrimitive.Cancel className="assistant-button assistant-button--ghost">停止</ComposerPrimitive.Cancel>
              <ComposerPrimitive.Send className="assistant-button assistant-button--send">
                发送
              </ComposerPrimitive.Send>
            </div>
          </ComposerPrimitive.Root>
          <p className="assistant-disclaimer">AI 可能出错；涉及生产发布、资金、敏感数据或不可逆动作时会进入人工审批。</p>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function SessionList({
  sessions,
  currentId,
  query,
  archived,
  loading,
  onQuery,
  onToggleArchived,
  onCreate,
  onSelect,
  onPin,
  onArchive,
  onDelete,
}: {
  sessions: AssistantSession[];
  currentId: string | null;
  query: string;
  archived: boolean;
  loading: boolean;
  onQuery: (value: string) => void;
  onToggleArchived: () => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onPin: (session: AssistantSession) => void;
  onArchive: (session: AssistantSession) => void;
  onDelete: (session: AssistantSession) => void;
}) {
  const grouped = useMemo(() => {
    const map = new Map<string, AssistantSession[]>();
    for (const session of sessions) {
      const group = sessionGroup(session);
      map.set(group, [...(map.get(group) ?? []), session]);
    }
    return [...map.entries()];
  }, [sessions]);
  return (
    <aside className="assistant-sidebar" aria-label="历史会话">
      <div className="assistant-brand">
        <div className="assistant-brand__mark">织</div>
        <div>
          <strong>织元研发台</strong>
          <span>AI 研发中心</span>
        </div>
        <span className="assistant-beta">测试版</span>
      </div>
      <button className="assistant-new" type="button" onClick={onCreate}>
        新建对话
      </button>
      <label className="assistant-search">
        <span aria-hidden="true">⌕</span>
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="搜索标题和消息"
          aria-label="搜索会话"
        />
      </label>
      <button
        type="button"
        className={`assistant-archive-filter ${archived ? "is-active" : ""}`}
        onClick={onToggleArchived}
      >
        {archived ? "← 返回进行中会话" : "查看归档会话"}
      </button>
      <div className="assistant-session-list" aria-busy={loading}>
        {loading ? <p className="assistant-side-empty">正在加载会话…</p> : null}
        {!loading && !sessions.length ? (
          <p className="assistant-side-empty">{query ? "没有匹配的会话" : archived ? "暂无归档会话" : "还没有会话，直接开始一个新问题。"}</p>
        ) : null}
        {grouped.map(([group, items]) => (
          <section key={group} className="assistant-session-group">
            <h2>{group}</h2>
            {items.map((session) => (
              <div
                key={session.id}
                className={`assistant-session ${currentId === session.id ? "is-active" : ""}`}
              >
                <button
                  type="button"
                  className="assistant-session__main"
                  onClick={() => onSelect(session.id)}
                  aria-current={currentId === session.id ? "page" : undefined}
                >
                  <span className="assistant-session__title">
                    {session.pinned ? <Icon name="pin" size={12} label="已置顶" /> : null}
                    <span className="wl-text-ellipsis" title={session.title}>{session.title}</span>
                  </span>
                  <span>{formatTime(session.lastMessageAt ?? session.createdAt)}</span>
                </button>
                <div className="assistant-session__tools">
                  <button type="button" onClick={() => onPin(session)} title={session.pinned ? "取消置顶" : "置顶"} aria-label={session.pinned ? "取消置顶" : "置顶"}><Icon name="pin" size={14} /></button>
                  <button type="button" onClick={() => onArchive(session)} title={archived ? "恢复会话" : "归档"} aria-label={archived ? "恢复会话" : "归档"}><Icon name="folder" size={14} /></button>
                  <button type="button" onClick={() => onDelete(session)} title="删除会话" aria-label="删除会话"><Icon name="close" size={14} /></button>
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
      <div className="assistant-sidebar__footer">
        <span className="assistant-live-dot" /> 真实模型 · 持久会话
      </div>
    </aside>
  );
}

function EvidencePanel({
  status: runtimeStatus,
  identity,
  evidence,
  events,
  messages,
  open,
  onClose,
  onDownload,
}: {
  status: AssistantStatus | null;
  identity: AssistantIdentity | null;
  evidence: RunEvidence | null;
  events: Array<{ type: string; at: string }>;
  messages: AssistantMessage[];
  open: boolean;
  onClose: () => void;
  onDownload: (path: string) => void;
}) {
  const run = evidence?.run;
  const task = evidence?.task;
  const usage = run?.usage;
  return (
    <aside className={`assistant-evidence ${open ? "is-open" : ""}`} aria-label="运行与证据">
      <header className="assistant-evidence__header">
        <div>
          <p className="assistant-eyebrow">运行证据</p>
          <h2>运行与证据</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭证据面板" title="关闭证据面板"><Icon name="close" size={16} /></button>
      </header>
      <section className="assistant-card">
        <h3>模型与服务</h3>
        <dl>
          <div><dt>请求模型</dt><dd>{modelName(runtimeStatus?.model)}</dd></div>
          <div><dt>凭据</dt><dd className={runtimeStatus?.modelConfigured ? "is-good" : "is-bad"}>{runtimeStatus?.modelConfigured ? "已配置" : "未配置"}</dd></div>
          <div><dt>联网搜索</dt><dd className={runtimeStatus?.webSearchConfigured ? "is-good" : "is-bad"}>{runtimeStatus?.webSearchConfigured ? `可用 · 每日 ${runtimeStatus.webSearchDailyLimit} 次` : "未配置"}</dd></div>
          <div><dt>流式</dt><dd>流式连接</dd></div>
          <div><dt>沙箱</dt><dd>{sandboxText(runtimeStatus?.codeExecution)}</dd></div>
          <div><dt>成员</dt><dd>{identity?.name ?? "—"}</dd></div>
        </dl>
      </section>
      <section className="assistant-card">
        <h3>当前运行</h3>
        {run ? (
          <>
            <div className={`assistant-run-state assistant-run-state--${run.status}`}>
              <span /> {clientStatusLabel(run.status)}
            </div>
            <dl>
              <div><dt>运行</dt><dd className="assistant-mono">{shortId(run.id)}</dd></div>
              <div><dt>模式</dt><dd>{run.mode === "task" ? "研发任务" : "真实问答"}</dd></div>
              {run.webSearchRequested ? (
                <div>
                  <dt>联网搜索</dt>
                  <dd>{run.searchStatus === "completed" ? `已返回 ${run.searchResultCount} 个来源` : run.searchStatus === "empty" ? "已搜索 · 无匹配来源" : clientStatusLabel(run.searchStatus)}</dd>
                </div>
              ) : null}
              <div><dt>输入用量</dt><dd>{usage?.promptTokens ?? "—"}</dd></div>
              <div><dt>输出用量</dt><dd>{usage?.completionTokens ?? "—"}</dd></div>
              <div><dt>响应模型</dt><dd className="assistant-mono">{modelName(run.responseModel)}</dd></div>
              <div><dt>响应编号</dt><dd className="assistant-mono">{shortId(run.responseId)}</dd></div>
            </dl>
            {run.error ? (
              <p className="assistant-inline-error">
                {clientChineseText(run.error, "模型运行异常，请查看服务日志")}
              </p>
            ) : null}
          </>
        ) : <p className="assistant-card__empty">发送消息后，这里会显示真实的模型与任务状态。</p>}
      </section>
      {task ? (
        <section className="assistant-card">
          <h3>任务图</h3>
          <div className="assistant-dag">
            {task.tasks.map((item, index) => (
              <div key={item.id} className={`assistant-dag__node is-${item.status}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong className="wl-text-ellipsis" title={actorText(item.presetKey)}>
                    {actorText(item.presetKey)}
                  </strong>
                  <small>{clientStatusLabel(item.status)}{item.error ? ` · ${clientChineseText(item.error, "任务状态已记录")}` : ""}</small>
                </div>
              </div>
            ))}
          </div>
          {task.artifacts.length ? (
            <div className="assistant-artifacts">
              <h3>已验证产物</h3>
              {task.artifacts.map((artifact) => (
                <button key={artifact.path} type="button" onClick={() => onDownload(artifact.path)}>
                  <span>{artifact.path}</span>
                  <small>{artifact.sizeBytes} 字节 · 摘要 {artifact.sha256.slice(0, 10)}…</small>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      <section className="assistant-card">
        <h3>事件流</h3>
        {events.length ? (
          <ol className="assistant-events">
            {events.slice(-10).reverse().map((event, index) => (
              <li key={`${event.at}-${event.type}-${index}`}>
                <span className="assistant-event-dot" />
                <div><strong>{eventTypeText(event.type)}</strong><small>{formatTime(event.at)}</small></div>
              </li>
            ))}
          </ol>
        ) : <p className="assistant-card__empty">尚无事件。</p>}
      </section>
      <section className="assistant-card">
        <h3>消息回执</h3>
        <dl>
          <div><dt>持久消息</dt><dd>{messages.length}</dd></div>
          <div><dt>运行证据</dt><dd>{run ? "已绑定" : "待产生"}</dd></div>
          <div><dt>外部动作</dt><dd>未启用</dd></div>
        </dl>
      </section>
    </aside>
  );
}

function Topbar({
  session,
  identity,
  onRename,
  onOpenSidebar,
  onOpenEvidence,
  onLogout,
}: {
  session: AssistantSession | null;
  identity: AssistantIdentity | null;
  onRename: (title: string) => Promise<void>;
  onOpenSidebar: () => void;
  onOpenEvidence: () => void;
  onLogout: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session?.title ?? "新对话");
  useEffect(() => {
    setTitle(session?.title ?? "新对话");
    setEditing(false);
  }, [session?.id, session?.title]);
  return (
    <header className="assistant-topbar">
      <button className="assistant-mobile-menu" type="button" onClick={onOpenSidebar} aria-label="打开会话列表" title="打开会话列表"><Icon name="menu" size={18} /></button>
      <div className="assistant-topbar__title">
        <span className="assistant-topbar__status" />
        {editing ? (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const next = title.trim();
              if (next) await onRename(next);
              setEditing(false);
            }}
          >
            <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} aria-label="会话标题" />
          </form>
        ) : (
          <button
            type="button"
            className="wl-text-ellipsis"
            onClick={() => setEditing(true)}
            title={session?.title ?? "新对话"}
          >
            {session?.title ?? "新对话"}
          </button>
        )}
        <span>{session?.pinned ? "已置顶" : "云端持久会话"}</span>
      </div>
      <div className="assistant-topbar__actions">
        <button type="button" className="assistant-topbar__evidence" onClick={onOpenEvidence}>证据</button>
        <div className="assistant-avatar" title={identity?.name ?? "管理员"}>{identity?.name?.slice(0, 1) ?? "鹏"}</div>
        <button type="button" className="assistant-logout" onClick={() => void onLogout()}>退出</button>
      </div>
    </header>
  );
}

function AccessGate({ state, error, onRetry }: { state: BootState; error: string; onRetry: () => void }) {
  return (
    <main className="assistant-access">
      <div className="assistant-access__grid" aria-hidden="true" />
      <section>
        <div className="assistant-brand__mark">织</div>
        <p className="assistant-eyebrow">织元研发中心 · 私有云</p>
        <h1>{state === "loading" ? "正在验证安全入口" : "请从鹏经理后台进入"}</h1>
        <p>
          {state === "loading"
            ? "正在核验一次性登录凭据和工作区成员身份。"
            : state === "error"
              ? clientChineseText(error, "安全入口验证失败，请联系管理员")
              : "AI 研发中心只接受鹏经理管理员的一次性安全握手，不开放公网注册。"}
        </p>
        {state !== "loading" ? (
          <>
            <a href="https://pengmanager.com/admin">打开鹏经理管理后台</a>
            {state === "error" ? <button type="button" onClick={onRetry}>重新验证</button> : null}
          </>
        ) : null}
        <small>模型密钥仅保存在云端服务进程，不会发送到浏览器。</small>
      </section>
    </main>
  );
}

export default function AssistantPage() {
  const [boot, setBoot] = useState<BootState>("loading");
  const [bootError, setBootError] = useState("");
  const [identity, setIdentity] = useState<AssistantIdentity | null>(null);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessionQuery, setSessionQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [mode, setMode] = useState<AssistantMode>("ask");
  const [webSearch, setWebSearch] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [activeRun, setActiveRun] = useState<AssistantRun | null>(null);
  const [evidence, setEvidence] = useState<RunEvidence | null>(null);
  const [events, setEvents] = useState<Array<{ type: string; at: string }>>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [pageError, setPageError] = useState("");
  const bootOnce = useRef(false);
  const currentSession = sessions.find((session) => session.id === currentSessionId) ?? null;

  const loadSessionList = useCallback(async (query = "", showArchived = false) => {
    setSessionsLoading(true);
    try {
      const result = await listSessions({ query: query.trim(), archived: showArchived });
      setSessions(result.sessions);
      return result.sessions;
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const selectSession = useCallback(async (id: string, sessionHint?: AssistantSession) => {
    setCurrentSessionId(id);
    setSidebarOpen(false);
    setPageError("");
    setEvents([]);
    try {
      const result = await listMessages(id);
      setMessages(result.messages);
      const session = sessionHint ?? sessions.find((item) => item.id === id);
      if (session?.lastRunId) {
        const run = await getRun(session.lastRunId).catch(() => null);
        setEvidence(run);
        setActiveRun(run?.run ?? null);
      } else {
        setEvidence(null);
        setActiveRun(null);
      }
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "会话加载失败");
    }
  }, [sessions]);

  const bootAssistant = useCallback(async (allowDev = true) => {
    setBoot("loading");
    setBootError("");
    try {
      const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const launchCode = params.get("__launch");
      if (launchCode) {
        const result = await exchangeLaunch(launchCode);
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        setIdentity(result.identity);
        setStatus(result.status);
      } else {
        try {
          const me = await assistantMe();
          setIdentity({
            memberNo: me.memberNo,
            name: me.name,
            role: me.role,
            workspaceId: me.workspaceId,
          });
          setStatus(me.status);
        } catch (error) {
          if (!allowDev || !import.meta.env.DEV || !(error instanceof AssistantApiError) || error.status !== 401) throw error;
          const { getToken } = await import("../../lib/trpc");
          const token = getToken();
          if (!token) throw error;
          const dev = await createDevCookie(token);
          const me = await assistantMe();
          setIdentity({
            ...dev.identity,
            role: me.role,
            workspaceId: me.workspaceId,
          });
          setStatus(me.status);
        }
      }
      const loaded = await loadSessionList();
      let first = loaded[0];
      if (!first) first = await createSession();
      setSessions(first ? [first, ...loaded.filter((item) => item.id !== first!.id)] : []);
      await selectSession(first.id, first);
      setBoot("ready");
    } catch (error) {
      setIdentity(null);
      setStatus(null);
      if (error instanceof AssistantApiError && ["UNAUTHENTICATED", "LAUNCH_CODE_EXPIRED", "SESSION_INVALID"].includes(error.code)) {
        setBoot("unauthorized");
      } else {
        setBoot("error");
        setBootError(error instanceof Error ? error.message : "安全入口验证失败");
      }
    }
  }, [loadSessionList, selectSession]);

  useEffect(() => {
    if (bootOnce.current) return;
    bootOnce.current = true;
    void bootAssistant();
  }, [bootAssistant]);

  useEffect(() => {
    if (boot !== "ready") return;
    const timer = setTimeout(() => {
      void loadSessionList(sessionQuery, archived).catch((error) => {
        setPageError(error instanceof Error ? error.message : "会话搜索失败");
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [sessionQuery, archived, boot, loadSessionList]);

  const refreshEvidence = useCallback(async (runId: string) => {
    const result = await getRun(runId).catch(() => null);
    if (result) {
      setEvidence(result);
      setActiveRun(result.run);
    }
  }, []);

  const consumeRun = useCallback(async (turn: {
    run: AssistantRun;
    userMessage: AssistantMessage;
    assistantMessage: AssistantMessage;
  }, appendMessages = true) => {
    setIsRunning(true);
    setPageError("");
    setActiveRun(turn.run);
    setEvidence({ run: turn.run, task: null });
    setEvents([{ type: "message.start", at: new Date().toISOString() }]);
    if (appendMessages) {
      setMessages((current) => {
        const withoutDuplicate = current.filter((message) =>
          message.id !== turn.userMessage.id && message.id !== turn.assistantMessage.id,
        );
        return [...withoutDuplicate, turn.userMessage, turn.assistantMessage];
      });
    }
    await new Promise<void>((resolve) => {
      let done = false;
      let stopPoll: ReturnType<typeof setInterval> | undefined;
      let cleanup = () => undefined as void;
      const finish = () => {
        if (done) return;
        done = true;
        if (stopPoll) clearInterval(stopPoll);
        cleanup();
        setIsRunning(false);
        void refreshEvidence(turn.run.id);
        void listMessages(turn.run.sessionId).then((result) => {
          setMessages(result.messages);
          void loadSessionList(sessionQuery, archived);
        }).catch(() => undefined);
        resolve();
      };
      cleanup = streamRunEvents(turn.run.id, {
        onEvent: (type, data, id) => {
          setEvents((current) => [...current.slice(-49), { type, at: new Date().toISOString() }]);
          if (type === "message.delta" && typeof data.delta === "string") {
            setMessages((current) => current.map((message) =>
              message.id === turn.assistantMessage.id ? appendText(message, data.delta as string) : message,
            ));
          }
          if (type === "task.updated") {
            setEvidence((current) => current ? {
              ...current,
              run: { ...current.run, status: "running", threadId: typeof data.taskRunId === "string" ? data.taskRunId : current.run.threadId },
            } : current);
          }
          if (type === "usage.updated" && typeof data.promptTokens === "number") {
            setActiveRun((current) => current ? { ...current, usage: data as unknown as AssistantRun["usage"] } : current);
          }
          if (type === "error") {
            setPageError(typeof data.message === "string" ? data.message : "模型运行失败");
          }
          if (type === "message.done") finish();
          if (!id) return;
        },
        onError: () => {
          setPageError((current) => current || "事件流暂时中断，正在尝试恢复…");
        },
      });
      stopPoll = setInterval(() => {
        void getRun(turn.run.id).then((result) => {
          setEvidence(result);
          setActiveRun(result.run);
          if (["completed", "failed", "cancelled", "interrupted", "blocked"].includes(result.run.status)) {
            if (result.run.error) setPageError(result.run.error);
            finish();
          }
        }).catch(() => undefined);
      }, 2_000);
    });
  }, [archived, loadSessionList, refreshEvidence, sessionQuery]);

  const handleSend = useCallback(async (text: string) => {
    let sessionId = currentSessionId;
    if (!sessionId) {
      const created = await createSession(text.slice(0, 50));
      sessionId = created.id;
      setCurrentSessionId(created.id);
      setSessions((current) => [created, ...current]);
    }
    const result = await sendMessage(sessionId, {
      text,
      mode,
      webSearch,
      clientMessageId: crypto.randomUUID(),
    });
    await consumeRun(result);
  }, [consumeRun, currentSessionId, mode, webSearch]);

  const handleStop = useCallback(async () => {
    if (!activeRun) return;
    const stopped = await stopRun(activeRun.id);
    setActiveRun(stopped);
    await refreshEvidence(stopped.id);
  }, [activeRun, refreshEvidence]);

  const handleRetry = useCallback(async () => {
    if (!activeRun || !["failed", "cancelled", "interrupted", "blocked"].includes(activeRun.status)) return;
    const retried = await retryRun(activeRun.id);
    await consumeRun(retried);
  }, [activeRun, consumeRun]);

  const handleCreate = useCallback(async () => {
    try {
      const created = await createSession();
      setArchived(false);
      setSessions((current) => [created, ...current]);
      setCurrentSessionId(created.id);
      setMessages([]);
      setEvidence(null);
      setActiveRun(null);
      setEvents([]);
      setPageError("");
      setSidebarOpen(false);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "新建会话失败");
    }
  }, []);

  const handlePin = useCallback(async (session: AssistantSession) => {
    try {
      const updated = await updateSession(session.id, { pinned: !session.pinned });
      setSessions((current) => current
        .map((item) => item.id === updated.id ? updated : item)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned)));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "置顶失败");
    }
  }, []);

  const handleArchive = useCallback(async (session: AssistantSession) => {
    try {
      await archiveSession(session.id, session.status !== "archived");
      const remaining = sessions.filter((item) => item.id !== session.id);
      setSessions(remaining);
      if (currentSessionId === session.id) {
        if (remaining[0]) await selectSession(remaining[0].id);
        else await handleCreate();
      }
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "归档失败");
    }
  }, [currentSessionId, handleCreate, selectSession, sessions]);

  const handleDelete = useCallback(async (session: AssistantSession) => {
    if (!window.confirm(`删除会话“${session.title}”？消息会软删除，审计事件仍保留。`)) return;
    try {
      await deleteSession(session.id);
      const remaining = sessions.filter((item) => item.id !== session.id);
      setSessions(remaining);
      if (currentSessionId === session.id) {
        if (remaining[0]) await selectSession(remaining[0].id);
        else await handleCreate();
      }
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "删除失败");
    }
  }, [currentSessionId, handleCreate, selectSession, sessions]);

  const handleDownload = useCallback(async (runId: string, path: string) => {
    try {
      const artifact = await getArtifact(runId, path);
      const blob = new Blob([artifact.content], { type: artifact.mediaType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = path.split("/").pop() || "artifact.txt";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "产物下载失败");
    }
  }, []);

  const handleLogout = useCallback(async () => {
    await logout().catch(() => undefined);
    setCsrfToken("");
    setBoot("unauthorized");
  }, []);

  if (boot !== "ready") {
    return <AccessGate state={boot} error={bootError} onRetry={() => void bootAssistant(false)} />;
  }

  return (
    <main className="assistant-app" data-workloom-client="assistant">
      {sidebarOpen ? <button className="assistant-drawer-scrim" type="button" aria-label="关闭会话列表" onClick={() => setSidebarOpen(false)} /> : null}
      <div className={sidebarOpen ? "assistant-sidebar-wrap is-open" : "assistant-sidebar-wrap"}>
        <SessionList
          sessions={sessions}
          currentId={currentSessionId}
          query={sessionQuery}
          archived={archived}
          loading={sessionsLoading}
          onQuery={setSessionQuery}
          onToggleArchived={() => setArchived((value) => !value)}
          onCreate={handleCreate}
          onSelect={(id) => void selectSession(id)}
          onPin={(session) => void handlePin(session)}
          onArchive={(session) => void handleArchive(session)}
          onDelete={(session) => void handleDelete(session)}
        />
      </div>
      <section className="assistant-main">
        <Topbar
          session={currentSession}
          identity={identity}
          onRename={async (title) => {
            if (!currentSession) return;
            const updated = await updateSession(currentSession.id, { title });
            setSessions((current) => current.map((item) => item.id === updated.id ? updated : item));
          }}
          onOpenSidebar={() => setSidebarOpen(true)}
          onOpenEvidence={() => setEvidenceOpen(true)}
          onLogout={handleLogout}
        />
        {pageError ? (
          <div className="assistant-errorbar" role="alert">
            <span>{clientChineseText(pageError, "操作未完成，请查看运行证据")}</span>
            {activeRun && ["failed", "cancelled", "interrupted", "blocked"].includes(activeRun.status) ? (
              <button type="button" onClick={() => void handleRetry()}>重试上一条</button>
            ) : null}
            <button type="button" onClick={() => setPageError("")} aria-label="关闭错误提示" title="关闭错误提示"><Icon name="close" size={15} /></button>
          </div>
        ) : null}
        <ConversationBoundary resetKey={currentSessionId}>
          <Conversation
            messages={messages}
            isRunning={isRunning}
            mode={mode}
            webSearch={webSearch}
            webSearchConfigured={status?.webSearchConfigured === true}
            onModeChange={setMode}
            onToggleWebSearch={() => setWebSearch((value) => !value)}
            onSend={handleSend}
            onStop={handleStop}
            onOpenEvidence={() => setEvidenceOpen(true)}
            onDownloadArtifact={(runId, path) => void handleDownload(runId, path)}
          />
        </ConversationBoundary>
      </section>
      <EvidencePanel
        status={status}
        identity={identity}
        evidence={evidence}
        events={events}
        messages={messages}
        open={evidenceOpen}
        onClose={() => setEvidenceOpen(false)}
        onDownload={(path) => {
          if (activeRun) void handleDownload(activeRun.id, path);
        }}
      />
      {evidenceOpen ? <button className="assistant-drawer-scrim assistant-drawer-scrim--evidence" type="button" aria-label="关闭证据面板" onClick={() => setEvidenceOpen(false)} /> : null}
    </main>
  );
}

# Cloud assistant workbench

The WorkLoom PM assistant is a separate conversation layer from Quest threads.
A conversation can contain many model runs and PM task runs, while a Quest
thread remains one executable task graph.

## Entry and authentication

Production entry: `https://pm.pengmanager.com/assistant`.

1. The PengManager administrator session calls `POST /api/workloom/launch`.
2. PengManager signs a 60-second Ed25519 assertion with `aud=workloom-pm`,
   the mapped WorkLoom tenant/workspace/member and a random `jti`.
3. WorkLoom verifies the code, consumes the `jti`, and sets independent
   `__Host-workloom_session` and CSRF cookies.
4. The fragment is removed from browser history. Replayed or expired codes are
   rejected.

WorkLoom does not receive the PengManager Cookie. The DeepSeek key remains in
the WorkLoom service environment and is never sent to a browser.

## Data

Migration `0055_assistant_workbench.sql` adds `assistant_sessions`,
`assistant_messages`, `assistant_runs`, `assistant_run_events`,
`assistant_budgets`, and `assistant_launch_nonces`.

Every business table is tenant/workspace scoped with forced RLS. Run events are
append-only. Messages are soft-deleted with their session; audit events remain.

## API

All routes are under `/api/assistant`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/exchange` | Consume one launch code and set HttpOnly session |
| GET | `/auth/me` | Current member and model/runtime status |
| POST | `/auth/logout` | Clear WorkLoom cookies |
| GET / POST | `/sessions` | List or create conversations |
| PATCH | `/sessions/:id` | Rename or pin |
| POST | `/sessions/:id/archive` | Archive or unarchive |
| DELETE | `/sessions/:id` | Soft delete |
| GET | `/sessions/:id/messages` | Persisted messages |
| POST | `/sessions/:id/messages` | Create ask/task run; optional `webSearch: true` |
| GET | `/runs/:id` | Run and linked PM evidence |
| GET | `/runs/:id/events` | SSE from `Last-Event-ID` |
| POST | `/runs/:id/stop` | Stop model or PM task |
| POST | `/runs/:id/retry` | Retry failed/cancelled run |
| GET | `/runs/:id/artifact` | Read one PM artifact by exact path |

Writes require same-origin Origin, matching double-submit CSRF values and body
limits. Ask mode calls DeepSeek Chat Completions with `stream=true`,
`stream_options.include_usage=true`, thinking disabled, and a bounded output
size. Task mode creates and monitors the existing PM team/DAG runtime.

## Web search

The web UI exposes an explicit `联网搜索` toggle. When enabled, the assistant
calls DeepSeek `POST /v1/tools/search` before the answer or PM task, passes the
returned summaries as clearly marked untrusted external material, and persists
the actual source titles, URLs and search receipt. The model is instructed to
cite only returned URLs and to disclose when results are empty or insufficient.

Search is deliberately separate from Chat Completions. It uses the same
DeepSeek credential and official origin, but has its own daily call budget.
Search failures fail the request instead of silently degrading to an unsourced
answer. Search and Fetch are read-only operations; fetched web text remains
untrusted and cannot grant tool or publishing authority.

## Model budget

`ASSISTANT_DAILY_CALL_LIMIT` defaults to 300 and
`ASSISTANT_DAILY_TOKEN_LIMIT` defaults to 2,000,000.
`ASSISTANT_DAILY_SEARCH_LIMIT` defaults to 100. Every physical request is
reserved locally before the provider call. Missing final model usage freezes the
ledger instead of recording zero; search calls are accounted separately.

## Linux code execution

On Linux, generated Node tests execute through `bubblewrap`:

- separate user, PID, UTC, IPC, cgroup and network namespaces;
- read-only `/usr`, `/bin`, `/lib`, Node runtime, runner and preload;
- writable only the disposable task workspace and tmpfs;
- Node permission model, no inherited secrets or host environment;
- 30-second wall clock, output cap, memory cap and fail-closed admission.

Missing `bubblewrap`, unsupported Node or an unsafe launch configuration returns
`OS_SANDBOX_UNAVAILABLE`; the code is not run on the host.

## Verification

Unit and HTTP tests:

```bash
pnpm --filter @workloom/server test
pnpm -C apps/web typecheck
pnpm -C apps/web build
pnpm test:assistant-218
```

The live suite runs on the application host:

```bash
DATABASE_URL=... JWT_SECRET=... \
ASSISTANT_EVAL_BASE_URL=http://127.0.0.1:8988 \
ASSISTANT_PUBLIC_ORIGIN=https://pm.pengmanager.com \
pnpm assistant:218
```

Each of the 218 cases creates a persisted session, calls the real model through
the public assistant API, consumes SSE, reads back the stored messages and run
receipt, validates strict JSON and domain-specific facts, and archives the test
session. Evidence is written under `outputs/assistant-218/<suite-id>/`.

## Deployment

See [deploy/linux/README.md](../deploy/linux/README.md). Production completion
requires the GitHub `main` SHA to match the installed release, HTTPS and admin
SSO readback, a real model answer, a completed task DAG with artifacts, Linux
sandbox negative tests, desktop/mobile screenshots, and all 218 live cases.

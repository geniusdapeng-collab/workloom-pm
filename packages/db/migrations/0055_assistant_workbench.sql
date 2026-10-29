-- 0055 · Cloud assistant workbench
-- Chat sessions are intentionally separate from Quest threads: one conversation may
-- create several PM runs, while a thread is already a single executable task graph.
-- Every mutable business object is tenant+workspace scoped; run events are append-only.

CREATE TABLE IF NOT EXISTS assistant_launch_nonces (
  jti_hash TEXT PRIMARY KEY CHECK (jti_hash ~ '^[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  member_no TEXT NOT NULL CHECK (char_length(member_no) BETWEEN 1 AND 80),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at),
  FOREIGN KEY (workspace_id, tenant_id) REFERENCES workspaces(id, tenant_id)
);

CREATE TABLE IF NOT EXISTS assistant_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_member_no TEXT NOT NULL CHECK (char_length(owner_member_no) BETWEEN 1 AND 80),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'deleted')),
  pinned BOOLEAN NOT NULL DEFAULT false,
  last_message_at TIMESTAMPTZ,
  last_run_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id, workspace_id),
  FOREIGN KEY (workspace_id, tenant_id) REFERENCES workspaces(id, tenant_id)
);

CREATE TABLE IF NOT EXISTS assistant_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_member_no TEXT NOT NULL CHECK (char_length(owner_member_no) BETWEEN 1 AND 80),
  user_message_id TEXT NOT NULL,
  assistant_message_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('ask', 'task')),
  model TEXT NOT NULL CHECK (char_length(model) BETWEEN 1 AND 120),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'blocked')),
  thread_id TEXT,
  response_id TEXT,
  usage JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(usage) = 'object'),
  error_code TEXT,
  error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id, workspace_id),
  FOREIGN KEY (session_id, tenant_id, workspace_id)
    REFERENCES assistant_sessions(id, tenant_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  seq BIGSERIAL UNIQUE NOT NULL,
  session_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_member_no TEXT NOT NULL CHECK (char_length(owner_member_no) BETWEEN 1 AND 80),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  parts JSONB NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(parts) = 'array' AND jsonb_array_length(parts) BETWEEN 1 AND 100),
  parent_message_id TEXT,
  client_message_id TEXT CHECK (client_message_id IS NULL OR char_length(client_message_id) BETWEEN 1 AND 160),
  run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'streaming', 'completed', 'failed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (id, session_id, tenant_id, workspace_id),
  FOREIGN KEY (session_id, tenant_id, workspace_id)
    REFERENCES assistant_sessions(id, tenant_id, workspace_id),
  FOREIGN KEY (parent_message_id, session_id, tenant_id, workspace_id)
    REFERENCES assistant_messages(id, session_id, tenant_id, workspace_id)
);

ALTER TABLE assistant_runs
  DROP CONSTRAINT IF EXISTS assistant_runs_user_message_fk,
  DROP CONSTRAINT IF EXISTS assistant_runs_assistant_message_fk;
ALTER TABLE assistant_runs
  ADD CONSTRAINT assistant_runs_user_message_fk
    FOREIGN KEY (user_message_id, session_id, tenant_id, workspace_id)
    REFERENCES assistant_messages(id, session_id, tenant_id, workspace_id),
  ADD CONSTRAINT assistant_runs_assistant_message_fk
    FOREIGN KEY (assistant_message_id, session_id, tenant_id, workspace_id)
    REFERENCES assistant_messages(id, session_id, tenant_id, workspace_id);

CREATE TABLE IF NOT EXISTS assistant_run_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (char_length(type) BETWEEN 1 AND 80),
  payload JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, tenant_id, workspace_id)
    REFERENCES assistant_runs(id, tenant_id, workspace_id),
  FOREIGN KEY (session_id, tenant_id, workspace_id)
    REFERENCES assistant_sessions(id, tenant_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS assistant_budgets (
  budget_date DATE NOT NULL,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  calls_reserved INTEGER NOT NULL DEFAULT 0 CHECK (calls_reserved >= 0),
  calls_used INTEGER NOT NULL DEFAULT 0 CHECK (calls_used >= 0),
  prompt_tokens_used BIGINT NOT NULL DEFAULT 0 CHECK (prompt_tokens_used >= 0),
  completion_tokens_used BIGINT NOT NULL DEFAULT 0 CHECK (completion_tokens_used >= 0),
  blocked BOOLEAN NOT NULL DEFAULT false,
  blocked_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (budget_date, tenant_id, workspace_id),
  FOREIGN KEY (workspace_id, tenant_id) REFERENCES workspaces(id, tenant_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_assistant_message_client_id
  ON assistant_messages(session_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assistant_sessions_owner_recent
  ON assistant_sessions(tenant_id, workspace_id, owner_member_no, status, pinned DESC, COALESCE(last_message_at, created_at) DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_session_seq
  ON assistant_messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_lower_parts
  ON assistant_messages(session_id, lower(parts::text));
CREATE INDEX IF NOT EXISTS idx_assistant_runs_session_created
  ON assistant_runs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_runs_active
  ON assistant_runs(tenant_id, workspace_id, status, updated_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_assistant_run_events_run_id
  ON assistant_run_events(run_id, id);

ALTER TABLE assistant_launch_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_launch_nonces FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_run_events FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_budgets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_assistant_launch_nonces_scope ON assistant_launch_nonces;
CREATE POLICY p_assistant_launch_nonces_scope ON assistant_launch_nonces
  USING (tenant_id=current_setting('app.tenant_id', true) AND workspace_id=current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id', true) AND workspace_id=current_setting('app.workspace_id', true));

DROP POLICY IF EXISTS p_assistant_sessions_scope ON assistant_sessions;
CREATE POLICY p_assistant_sessions_scope ON assistant_sessions
  USING (tenant_id=current_setting('app.tenant_id', true) AND workspace_id=current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id', true) AND workspace_id=current_setting('app.workspace_id', true));

DROP POLICY IF EXISTS p_assistant_messages_scope ON assistant_messages;
CREATE POLICY p_assistant_messages_scope ON assistant_messages
  USING (tenant_id=current_setting('app.tenant_id', true) AND workspace_id=current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id', true) AND workspace_id=current_setting('app.workspace_id', true));

DROP POLICY IF EXISTS p_assistant_runs_scope ON assistant_runs;
CREATE POLICY p_assistant_runs_scope ON assistant_runs
  USING (tenant_id=current_setting('app.tenant_id', true) AND workspace_id=current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id', true) AND workspace_id=current_setting('app.workspace_id', true));

DROP POLICY IF EXISTS p_assistant_run_events_scope ON assistant_run_events;
CREATE POLICY p_assistant_run_events_scope ON assistant_run_events
  USING (tenant_id=current_setting('app.tenant_id', true) AND workspace_id=current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id', true) AND workspace_id=current_setting('app.workspace_id', true));

DROP POLICY IF EXISTS p_assistant_budgets_scope ON assistant_budgets;
CREATE POLICY p_assistant_budgets_scope ON assistant_budgets
  USING (tenant_id=current_setting('app.tenant_id', true) AND workspace_id=current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id', true) AND workspace_id=current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE ON assistant_launch_nonces TO workloom_app;
GRANT SELECT, INSERT, UPDATE ON assistant_sessions TO workloom_app;
GRANT SELECT, INSERT, UPDATE ON assistant_messages TO workloom_app;
GRANT SELECT, INSERT, UPDATE ON assistant_runs TO workloom_app;
GRANT SELECT, INSERT ON assistant_run_events TO workloom_app;
GRANT USAGE, SELECT ON SEQUENCE assistant_messages_seq_seq TO workloom_app;
GRANT SELECT, INSERT, UPDATE ON assistant_budgets TO workloom_app;
REVOKE DELETE, TRUNCATE ON assistant_launch_nonces, assistant_sessions, assistant_messages,
  assistant_runs, assistant_run_events, assistant_budgets FROM workloom_app;
REVOKE UPDATE ON assistant_run_events FROM workloom_app;

CREATE OR REPLACE FUNCTION assistant_run_events_append_only() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'assistant run events are append-only';
END;
$$;
DROP TRIGGER IF EXISTS trg_assistant_run_events_append_only ON assistant_run_events;
CREATE TRIGGER trg_assistant_run_events_append_only
  BEFORE UPDATE OR DELETE ON assistant_run_events
  FOR EACH ROW EXECUTE FUNCTION assistant_run_events_append_only();

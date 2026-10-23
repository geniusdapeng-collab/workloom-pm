-- MC-PM-002: independent AI-PM sandbox delivery, preserving the shared Quest contract.
-- The source tree has no 0043 migration. All facts are scoped by tenant AND workspace;
-- composite foreign keys prevent forging a task/artifact belonging to another scope.

CREATE UNIQUE INDEX IF NOT EXISTS ux_pm_workspace_identity ON workspaces (id, tenant_id);

CREATE TABLE IF NOT EXISTS pm_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 120),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  goal TEXT NOT NULL CHECK (char_length(goal) BETWEEN 4 AND 32000),
  requested_employee TEXT,
  checks JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(checks)='array' AND jsonb_array_length(checks)<=30),
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN
    ('created','planning','running','paused','blocked','failed','completed','cancelled')),
  model_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  plan_version INTEGER NOT NULL DEFAULT 0 CHECK (plan_version>=0),
  planning_receipt JSONB,
  planning_attempt INTEGER NOT NULL DEFAULT 0 CHECK (planning_attempt>=0),
  planning_metered_attempt INTEGER NOT NULL DEFAULT 0 CHECK (planning_metered_attempt>=0),
  planning_receipts JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(planning_receipts)='array'),
  verification JSONB,
  prompt_tokens BIGINT NOT NULL DEFAULT 0 CHECK (prompt_tokens>=0),
  completion_tokens BIGINT NOT NULL DEFAULT 0 CHECK (completion_tokens>=0),
  created_by TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  error_code TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id, workspace_id),
  UNIQUE (tenant_id, workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, tenant_id) REFERENCES workspaces(id, tenant_id)
);

CREATE TABLE IF NOT EXISTS pm_tasks (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (char_length(id) BETWEEN 1 AND 60),
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 7),
  preset_key TEXT NOT NULL,
  goal TEXT NOT NULL CHECK (char_length(goal) BETWEEN 4 AND 32000),
  depends_on JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(depends_on)='array'),
  acceptance JSONB NOT NULL CHECK (jsonb_typeof(acceptance)='array' AND jsonb_array_length(acceptance) BETWEEN 1 AND 12),
  output_refs JSONB NOT NULL CHECK (jsonb_typeof(output_refs)='array' AND jsonb_array_length(output_refs) BETWEEN 1 AND 12),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','running','paused','blocked','failed','completed','cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt>=0),
  metered_attempt INTEGER NOT NULL DEFAULT 0 CHECK (metered_attempt>=0),
  attempt_receipts JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(attempt_receipts)='array'),
  lease_owner TEXT,
  summary TEXT,
  error_code TEXT,
  error TEXT,
  usage JSONB,
  model_id TEXT,
  response_id TEXT,
  fence_impacts JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(fence_impacts)='array'),
  adapter_receipt JSONB,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, id, tenant_id, workspace_id),
  UNIQUE (run_id, ordinal, tenant_id, workspace_id),
  FOREIGN KEY (run_id, tenant_id, workspace_id) REFERENCES pm_runs(id, tenant_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS pm_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL CHECK (char_length(path) BETWEEN 1 AND 220),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 262144),
  media_type TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, tenant_id, workspace_id, path),
  FOREIGN KEY (run_id, task_id, tenant_id, workspace_id)
    REFERENCES pm_tasks(run_id, id, tenant_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_pm_runs_scope_created ON pm_runs (tenant_id, workspace_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_pm_runs_scope_status ON pm_runs (tenant_id, workspace_id, status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_pm_tasks_ready ON pm_tasks (tenant_id, workspace_id, run_id, status, ordinal);
CREATE INDEX IF NOT EXISTS idx_pm_artifacts_task ON pm_artifacts (tenant_id, workspace_id, run_id, task_id);

ALTER TABLE pm_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_pm_runs_scope ON pm_runs;
CREATE POLICY p_pm_runs_scope ON pm_runs
  USING (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE pm_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_pm_tasks_scope ON pm_tasks;
CREATE POLICY p_pm_tasks_scope ON pm_tasks
  USING (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true));
ALTER TABLE pm_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_artifacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_pm_artifacts_scope ON pm_artifacts;
CREATE POLICY p_pm_artifacts_scope ON pm_artifacts
  USING (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true));

GRANT SELECT, INSERT, UPDATE ON pm_runs, pm_tasks TO workloom_app;
GRANT SELECT, INSERT ON pm_artifacts TO workloom_app;
REVOKE UPDATE, DELETE, TRUNCATE ON pm_artifacts FROM workloom_app;
REVOKE DELETE, TRUNCATE ON pm_runs, pm_tasks FROM workloom_app;

CREATE OR REPLACE FUNCTION pm_artifact_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pm artifact receipts are append-only; create a new run for corrections';
END;
$$;
DROP TRIGGER IF EXISTS trg_pm_artifact_immutable ON pm_artifacts;
CREATE TRIGGER trg_pm_artifact_immutable BEFORE UPDATE OR DELETE ON pm_artifacts
  FOR EACH ROW EXECUTE FUNCTION pm_artifact_immutable();

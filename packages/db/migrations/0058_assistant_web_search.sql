-- 0058 · DeepSeek Search integration for assistant conversations.
-- Search calls have their own daily budget because DeepSeek bills them per
-- successful request rather than by model token.

ALTER TABLE assistant_runs
  ADD COLUMN IF NOT EXISTS web_search_requested BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS search_status TEXT NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS search_query TEXT,
  ADD COLUMN IF NOT EXISTS search_result_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS search_completed_at TIMESTAMPTZ;

ALTER TABLE assistant_runs
  DROP CONSTRAINT IF EXISTS assistant_runs_search_status_check,
  DROP CONSTRAINT IF EXISTS assistant_runs_search_result_count_check,
  DROP CONSTRAINT IF EXISTS assistant_runs_search_query_check;
ALTER TABLE assistant_runs
  ADD CONSTRAINT assistant_runs_search_status_check CHECK (
    search_status IN ('not_requested', 'searching', 'completed', 'empty', 'failed', 'blocked')
  ),
  ADD CONSTRAINT assistant_runs_search_result_count_check CHECK (search_result_count >= 0),
  ADD CONSTRAINT assistant_runs_search_query_check CHECK (
    search_query IS NULL OR char_length(search_query) BETWEEN 1 AND 128
  );

ALTER TABLE assistant_budgets
  ADD COLUMN IF NOT EXISTS search_calls_reserved INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS search_calls_used INTEGER NOT NULL DEFAULT 0;

ALTER TABLE assistant_budgets
  DROP CONSTRAINT IF EXISTS assistant_budgets_search_calls_reserved_check,
  DROP CONSTRAINT IF EXISTS assistant_budgets_search_calls_used_check;
ALTER TABLE assistant_budgets
  ADD CONSTRAINT assistant_budgets_search_calls_reserved_check CHECK (search_calls_reserved >= 0),
  ADD CONSTRAINT assistant_budgets_search_calls_used_check CHECK (search_calls_used >= 0);

CREATE INDEX IF NOT EXISTS idx_assistant_runs_search_status
  ON assistant_runs(tenant_id, workspace_id, search_status, created_at DESC)
  WHERE web_search_requested;

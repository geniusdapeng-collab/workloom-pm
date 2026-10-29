-- 0057 · Preserve both the requested model alias and the provider-reported model.

ALTER TABLE assistant_runs
  ADD COLUMN IF NOT EXISTS response_model TEXT;

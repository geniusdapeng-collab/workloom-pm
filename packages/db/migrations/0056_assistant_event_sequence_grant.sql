-- 0056 · Assistant workbench runtime grant discovered by isolated PostgreSQL E2E.
-- BIGSERIAL primary key id creates assistant_run_events_id_seq; appends need USAGE
-- on that sequence in addition to INSERT on the table.

GRANT USAGE, SELECT ON SEQUENCE assistant_run_events_id_seq TO workloom_app;

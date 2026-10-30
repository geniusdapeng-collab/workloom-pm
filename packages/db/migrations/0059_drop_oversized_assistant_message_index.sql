-- 0059 · Assistant search source cards made messages legitimately exceed the
-- PostgreSQL B-tree row-size limit. The old expression index stored the full
-- JSON text and caused otherwise-valid assistant responses to fail on insert.
-- Session listing already constrains by ownership and workspace; substring
-- search remains explicit LIKE matching without an unsafe index expression.

DROP INDEX IF EXISTS idx_assistant_messages_lower_parts;

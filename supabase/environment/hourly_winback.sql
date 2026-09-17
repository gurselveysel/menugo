-- ALREADY SCHEDULED on the existing MenuGO project. Do not create duplicate jobs.
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('menugo-winback-evaluation','5 * * * *','select ops.crm_enqueue();');
-- Evaluation only. No HTTP calls; default campaign dry_run; SMS switch false.

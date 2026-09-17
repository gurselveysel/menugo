DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['api_throttles','charge_allocations','check_channels','check_members','checkout_plans','checkout_shares','crm_campaigns','crm_consent_events','crm_iys_permissions','crm_outbox','crm_purchase_facts','crm_runs','integration_features','owner_invites','payment_intents'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='ops' AND tablename=t AND policyname='client_operations_denied') THEN
 EXECUTE format('CREATE POLICY client_operations_denied ON ops.%I AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false)',t);END IF;
 END LOOP;END;$$;

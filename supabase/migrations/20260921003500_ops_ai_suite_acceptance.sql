-- MenüGO AI suite r35 | Company-only, read-only acceptance evidence snapshot.
-- This does not mark the suite complete, mutate business data, reveal secrets, or enable paid providers.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE OR REPLACE FUNCTION ops.ai_suite_acceptance_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_principal jsonb;
  v_branch_count bigint:=0;
  v_enabled_routes bigint:=0;
  v_real_provider_attempts bigint:=0;
  v_menu_provider_runs bigint:=0;
  v_menu_applied bigint:=0;
  v_photo_provider_jobs bigint:=0;
  v_photo_publications bigint:=0;
  v_copy_provider_jobs bigint:=0;
  v_copy_applies bigint:=0;
  v_campaign_provider_jobs bigint:=0;
  v_social_external bigint:=0;
  v_assistant_provider_runs bigint:=0;
  v_assistant_commands bigint:=0;
  v_invoice_provider_jobs bigint:=0;
  v_purchase_entries bigint:=0;
  v_recipe_versions bigint:=0;
  v_master_items bigint:=0;
  v_master_bindings bigint:=0;
  v_local_price_overrides bigint:=0;
  v_best_service_days bigint:=0;
  v_best_completed_orders bigint:=0;
  v_best_waste_events bigint:=0;
  v_demand_ready boolean:=false;
  v_waste_ready boolean:=false;
BEGIN
  -- platform_principal is the single company-role boundary; restaurant roles cannot pass it.
  v_principal:=ops.platform_principal();

  SELECT count(*) INTO v_branch_count FROM ops.branch_settings;
  SELECT count(*) INTO v_enabled_routes
  FROM ops.ai_free_routes
  WHERE enabled AND attested_until>clock_timestamp();
  SELECT count(*) INTO v_real_provider_attempts
  FROM ops.ai_free_attempts
  WHERE state='success';

  SELECT count(*) INTO v_menu_provider_runs
  FROM ops.menu_import_runs r
  WHERE r.state='finished' AND r.model IS NOT NULL;
  SELECT count(*) INTO v_menu_applied
  FROM ops.menu_import_jobs j
  WHERE j.status IN('applied','reverted') AND j.apply_receipt IS NOT NULL;

  SELECT count(*) INTO v_photo_provider_jobs
  FROM ops.studio_jobs j
  WHERE j.kind='photo-enhance' AND j.state IN('review','approved')
    AND j.model IS NOT NULL AND j.result IS NOT NULL AND j.error_code IS NULL;
  SELECT count(*) INTO v_photo_publications
  FROM ops.studio_photo_publications p
  WHERE p.action='publish';

  SELECT count(*) INTO v_copy_provider_jobs
  FROM ops.studio_jobs j
  WHERE j.kind IN('product-copy','translation') AND j.state IN('review','approved')
    AND j.model IS NOT NULL AND j.result IS NOT NULL AND j.error_code IS NULL;
  SELECT count(*) INTO v_copy_applies
  FROM ops.studio_text_changes c
  WHERE c.action='apply';

  SELECT count(*) INTO v_campaign_provider_jobs
  FROM ops.studio_jobs j
  WHERE j.kind='campaign' AND j.state IN('review','approved')
    AND j.model IS NOT NULL AND j.result IS NOT NULL AND j.error_code IS NULL;
  SELECT count(*) INTO v_social_external
  FROM ops.social_publication_intents s
  WHERE s.external_ref IS NOT NULL;

  SELECT count(*) INTO v_assistant_provider_runs
  FROM ops.llm_runs r
  JOIN ops.ai_free_attempts a ON a.run_id=r.id AND a.state='success'
  WHERE r.kind='assistant' AND r.state='succeeded';
  SELECT count(*) INTO v_assistant_commands FROM ops.assistant_commands;

  SELECT count(*) INTO v_invoice_provider_jobs
  FROM ops.studio_jobs j
  WHERE j.kind='invoice' AND j.state IN('review','approved')
    AND j.model IS NOT NULL AND j.result IS NOT NULL AND j.error_code IS NULL;
  SELECT count(*) INTO v_purchase_entries FROM ops.purchase_entries;
  SELECT count(*) INTO v_recipe_versions FROM ops.recipe_versions;

  SELECT count(*) INTO v_master_items FROM ops.master_menu_items WHERE active;
  SELECT count(*) INTO v_master_bindings FROM ops.master_menu_bindings;
  SELECT count(*) INTO v_local_price_overrides FROM ops.branch_price_overrides;

  WITH per_branch AS (
    SELECT b.business_id,b.branch_id,
      count(DISTINCT (coalesce(o.submitted_at,o.created_at) AT TIME ZONE b.timezone)::date)
        FILTER (WHERE o.status IN('served','completed') AND coalesce(o.submitted_at,o.created_at)>=clock_timestamp()-interval '90 days')::bigint AS service_days,
      count(o.id) FILTER (WHERE o.status IN('served','completed') AND coalesce(o.submitted_at,o.created_at)>=clock_timestamp()-interval '90 days')::bigint AS completed_orders,
      (SELECT count(*)::bigint FROM ops.waste_events w WHERE w.business_id=b.business_id AND w.branch_id=b.branch_id AND w.observed_at>=clock_timestamp()-interval '90 days') AS waste_events
    FROM ops.branch_settings b
    LEFT JOIN ops.orders o ON o.business_id=b.business_id AND o.branch_id=b.branch_id
    GROUP BY b.business_id,b.branch_id,b.timezone
  )
  SELECT coalesce(max(service_days),0),coalesce(max(completed_orders),0),coalesce(max(waste_events),0),
         coalesce(bool_or(service_days>=14 AND completed_orders>=50),false),
         coalesce(bool_or(service_days>=14 AND completed_orders>=50 AND waste_events>=10),false)
  INTO v_best_service_days,v_best_completed_orders,v_best_waste_events,v_demand_ready,v_waste_ready
  FROM per_branch;

  RETURN jsonb_build_object(
    'generatedAt',clock_timestamp(),
    'role',v_principal->>'role',
    'policy',jsonb_build_object(
      'companyOnly',true,
      'freeOnly',true,
      'paidFallback',false,
      'autoCompletion',false
    ),
    'providerEvidence',jsonb_build_object(
      'enabledRoutes',v_enabled_routes::text,
      'successfulAttempts',v_real_provider_attempts::text,
      'configured',v_enabled_routes>0,
      'realSuccessSeen',v_real_provider_attempts>0
    ),
    'modules',jsonb_build_array(
      jsonb_build_object('id','menuImport','label','Fotoğraf/PDF menü aktarımı','providerRuns',v_menu_provider_runs::text,'reviewedApplications',v_menu_applied::text,'automaticEvidenceReady',v_menu_provider_runs>0 AND v_menu_applied>0,'externalAcceptanceRequired',true),
      jsonb_build_object('id','photoStudio','label','Ürün fotoğraf stüdyosu','providerJobs',v_photo_provider_jobs::text,'publications',v_photo_publications::text,'automaticEvidenceReady',v_photo_provider_jobs>0 AND v_photo_publications>0,'externalAcceptanceRequired',true),
      jsonb_build_object('id','copyTranslation','label','Ürün açıklaması ve çeviri','providerJobs',v_copy_provider_jobs::text,'applies',v_copy_applies::text,'automaticEvidenceReady',v_copy_provider_jobs>0 AND v_copy_applies>0,'externalAcceptanceRequired',true),
      jsonb_build_object('id','campaignSocial','label','Kampanya ve yetkili sosyal yayın','providerJobs',v_campaign_provider_jobs::text,'externalDispatches',v_social_external::text,'automaticEvidenceReady',v_campaign_provider_jobs>0 AND v_social_external>0,'externalAcceptanceRequired',true),
      jsonb_build_object('id','operatorAssistant','label','Veri kaynaklı işletme asistanı','providerRuns',v_assistant_provider_runs::text,'confirmedCommands',v_assistant_commands::text,'automaticEvidenceReady',v_assistant_provider_runs>0 AND v_assistant_commands>0,'externalAcceptanceRequired',true),
      jsonb_build_object('id','invoiceRecipe','label','Fatura ve reçete maliyeti','providerJobs',v_invoice_provider_jobs::text,'postedPurchases',v_purchase_entries::text,'recipeVersions',v_recipe_versions::text,'automaticEvidenceReady',v_invoice_provider_jobs>0 AND v_purchase_entries>0 AND v_recipe_versions>0,'externalAcceptanceRequired',true),
      jsonb_build_object('id','voiceOrder','label','Sesli sipariş taslağı','automaticEvidenceReady',false,'externalAcceptanceRequired',true,'reason','Fiziksel cihaz ve gerçek kullanıcı kabulü otomatik kayıtlardan kanıtlanamaz.'),
      jsonb_build_object('id','customerAssistant','label','Müşteri menü yardımcısı','automaticEvidenceReady',false,'externalAcceptanceRequired',true,'reason','Gerçek sağlayıcı ve gerçek müşteri cihazı kabulü gerekir.'),
      jsonb_build_object('id','demandWaste','label','Üretim ve fire tahmini','serviceDays',v_best_service_days::text,'completedOrders',v_best_completed_orders::text,'wasteEvents',v_best_waste_events::text,'demandReady',v_demand_ready,'wasteReady',v_waste_ready,'automaticEvidenceReady',v_demand_ready AND v_waste_ready,'externalAcceptanceRequired',true),
      jsonb_build_object('id','multiBranch','label','Çok şubeli ana menü ve yerel fiyat','branches',v_branch_count::text,'masterItems',v_master_items::text,'bindings',v_master_bindings::text,'localPriceOverrides',v_local_price_overrides::text,'automaticEvidenceReady',v_branch_count>=2 AND v_master_items>0 AND v_master_bindings>=2 AND v_local_price_overrides>0,'externalAcceptanceRequired',true)
    ),
    'completion',jsonb_build_object(
      'complete',false,
      'reason','Bu görünüm yalnız üretim kayıtlarından otomatik kanıt toplar. Tam kapsam; gerçek sağlayıcı, gerçek alan adı, fiziksel cihaz, yetkili sosyal yayın, ikinci gerçek şube ve yeterli gerçek geçmiş kabulü tamamlanmadan işaretlenmez.'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION ops.ai_suite_acceptance_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.ai_suite_acceptance_snapshot() TO authenticated,service_role;

COMMIT;

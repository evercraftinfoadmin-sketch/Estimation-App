-- One-time upload of a browser's existing data (localStorage + IndexedDB photos metadata).
-- Insert-only: nothing that already exists in the cloud is ever overwritten.
--   * a record whose id already exists in the cloud is skipped
--   * an estimate whose number is already used by another estimate is skipped (reported)
--   * a second CRM project for an estimate that already has one is skipped (reported)
--   * links (estimate ↔ project, photo → project) are only kept if the target will exist,
--     so the import can never leave a broken link
--   * one transaction: on any unexpected error nothing is written
-- p_data: {settings:{…}, categories:[…], services:[…], estimates:[…], crm_projects:[…],
--          project_photos:[…], next_estimate_number:int} with rows in table-column format
--          (the app's import code converts its camelCase records). org_id is forced to p_org.

-- created_at / updated_at may be omitted by the importer for settings
create or replace function public.tg_settings_insert()
returns trigger language plpgsql as $$
begin
  new.updated_at := coalesce(new.updated_at, now());
  new.updated_by := coalesce(new.updated_by, auth.uid());
  return new;
end $$;
create trigger settings_insert before insert on public.org_settings
  for each row execute function public.tg_settings_insert();

-- Column defaults for imported rows: older local records may lack fields; missing or null
-- values for NOT NULL columns get the same defaults the app uses.
create or replace function public.import_defaults(p_table text)
returns jsonb language sql immutable as $$
  select case p_table
    when 'org_settings' then '{"company_name":"","company_email":"","company_phone":"","company_address":"",
      "license_number":"","estimate_footer":"","terms":"","markup":25,"sales_tax":0,"tax_mode":"all",
      "next_estimate_number":1001,"extra":{}}'::jsonb
    when 'categories' then '{}'::jsonb
    when 'services' then '{"description":"","active":true,"default_price":0}'::jsonb
    when 'estimates' then '{"client_name":"","client_email":"","client_phone":"","address":"","address_status":"unverified",
      "address_street_number":"","address_route":"","address_unit":"","address_city":"","address_state":"",
      "address_postal_code":"","address_country":"","address_place_id":"","items":[],"custom_categories":[],
      "category_totals":{},"drywall_total":0,"stucco_total":0,"painting_total":0,"other_total":0,"subtotal":0,
      "markup":0,"markup_amount":0,"tax_rate":0,"tax_mode":"all","tax_amount":0,"customer_total":0,
      "status":"draft","extra":{},"version":1}'::jsonb
    when 'crm_projects' then '{"client_name":"","client_email":"","client_phone":"","address":"","address_status":"unverified",
      "address_street_number":"","address_route":"","address_unit":"","address_city":"","address_state":"",
      "address_postal_code":"","address_country":"","address_place_id":"","estimate_number":"","estimate_total":0,
      "stage":"lead","prospect_status":"needs_action","assigned_technician":"","notes":"","tasks":[],
      "follow_up_type":"client","follow_up_notes":"","follow_up_completed":false,"extra":{},"version":1}'::jsonb
    when 'project_photos' then '{"name":"","caption":""}'::jsonb
    else '{}'::jsonb end;
$$;

create or replace function public.import_local_data(p_org uuid, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_report        jsonb := '{}'::jsonb;
  v_n             integer;
  v_total         integer;
  v_cat_map       jsonb;
  v_est_in        jsonb := coalesce(p_data->'estimates', '[]'::jsonb);
  v_proj_in       jsonb := coalesce(p_data->'crm_projects', '[]'::jsonb);
  v_skip_est_num  text[];
  v_e_final       text[];
  v_skip_proj_dup text[];
  v_p_final       text[];
begin
  if not public.has_role(p_org, array['owner','admin']) then
    raise exception 'Only an owner or admin can import data' using errcode = '42501';
  end if;

  -- settings: only if the organization has none yet
  if jsonb_typeof(p_data->'settings') = 'object' then
    insert into public.org_settings
      select (jsonb_populate_record(null::public.org_settings, public.import_defaults('org_settings') || jsonb_strip_nulls(p_data->'settings') || jsonb_build_object('org_id', p_org))).*
      on conflict (org_id) do nothing;
    get diagnostics v_n = row_count;
    v_report := v_report || jsonb_build_object('settings', case when v_n = 1 then 'imported' else 'kept existing cloud settings' end);
  end if;

  -- custom categories
  insert into public.categories
    select (jsonb_populate_record(null::public.categories, public.import_defaults('categories') || jsonb_strip_nulls(x) || jsonb_build_object('org_id', p_org))).*
      from jsonb_array_elements(coalesce(p_data->'categories', '[]'::jsonb)) x
    on conflict do nothing;
  get diagnostics v_n = row_count;
  v_total := jsonb_array_length(coalesce(p_data->'categories', '[]'::jsonb));
  -- a local category whose name already exists in the cloud under another id: its services use the cloud one
  select coalesce(jsonb_object_agg(x->>'id', c.id), '{}'::jsonb) into v_cat_map
    from jsonb_array_elements(coalesce(p_data->'categories', '[]'::jsonb)) x
    join public.categories c on c.org_id = p_org and c.deleted_at is null
                            and lower(c.name) = lower(x->>'name') and c.id <> x->>'id'
   where not exists (select 1 from public.categories c2 where c2.org_id = p_org and c2.id = x->>'id');
  v_report := v_report || jsonb_build_object('categories',
    jsonb_build_object('imported', v_n, 'skipped', v_total - v_n, 'merged_by_name', v_cat_map));

  -- services
  insert into public.services
    select (jsonb_populate_record(null::public.services, public.import_defaults('services') || jsonb_strip_nulls(x) || jsonb_build_object(
              'org_id', p_org, 'category', coalesce(v_cat_map->>(x->>'category'), x->>'category')))).*
      from jsonb_array_elements(coalesce(p_data->'services', '[]'::jsonb)) x
    on conflict do nothing;
  get diagnostics v_n = row_count;
  v_total := jsonb_array_length(coalesce(p_data->'services', '[]'::jsonb));
  v_report := v_report || jsonb_build_object('services', jsonb_build_object('imported', v_n, 'skipped', v_total - v_n));

  -- which estimates will exist afterwards
  select coalesce(array_agg(x->>'id'), '{}') into v_skip_est_num
    from jsonb_array_elements(v_est_in) x
   where not exists (select 1 from public.estimates e where e.org_id = p_org and e.id = x->>'id')
     and exists (select 1 from public.estimates e where e.org_id = p_org and e.estimate_number = x->>'estimate_number');
  select coalesce(array_agg(id), '{}') into v_e_final from (
    select id from public.estimates where org_id = p_org
    union
    select x->>'id' from jsonb_array_elements(v_est_in) x where not ((x->>'id') = any(v_skip_est_num))
  ) s;

  -- which projects will exist afterwards (estimate links to missing estimates are dropped first)
  with inc as (
    select x->>'id' as id,
           case when (x->>'estimate_id') = any(v_e_final) then x->>'estimate_id' end as estimate_id,
           ord
      from jsonb_array_elements(v_proj_in) with ordinality as t(x, ord)
     where nullif(x->>'deleted_at', '') is null
  ), fresh as (
    select * from inc where not exists (select 1 from public.crm_projects p where p.org_id = p_org and p.id = inc.id)
  )
  select coalesce(array_agg(f.id), '{}') into v_skip_proj_dup
    from fresh f
   where f.estimate_id is not null and (
         exists (select 1 from public.crm_projects p where p.org_id = p_org and p.deleted_at is null and p.estimate_id = f.estimate_id)
      or exists (select 1 from fresh f2 where f2.estimate_id = f.estimate_id and f2.ord < f.ord));
  select coalesce(array_agg(id), '{}') into v_p_final from (
    select id from public.crm_projects where org_id = p_org
    union
    select x->>'id' from jsonb_array_elements(v_proj_in) x where not ((x->>'id') = any(v_skip_proj_dup))
  ) s;

  -- estimates
  insert into public.estimates
    select (jsonb_populate_record(null::public.estimates, public.import_defaults('estimates') || jsonb_strip_nulls(x) || jsonb_build_object(
              'org_id', p_org,
              'crm_project_id', case when (x->>'crm_project_id') = any(v_p_final) then x->>'crm_project_id' end))).*
      from jsonb_array_elements(v_est_in) x
     where not ((x->>'id') = any(v_skip_est_num))
    on conflict do nothing;
  get diagnostics v_n = row_count;
  v_report := v_report || jsonb_build_object('estimates', jsonb_build_object(
    'imported', v_n,
    'skipped', jsonb_array_length(v_est_in) - v_n,
    'skipped_number_in_use', (select coalesce(jsonb_agg(jsonb_build_object('id', x->>'id', 'estimate_number', x->>'estimate_number')), '[]'::jsonb)
                                from jsonb_array_elements(v_est_in) x where (x->>'id') = any(v_skip_est_num))));

  -- CRM projects
  insert into public.crm_projects
    select (jsonb_populate_record(null::public.crm_projects, public.import_defaults('crm_projects') || jsonb_strip_nulls(x) || jsonb_build_object(
              'org_id', p_org,
              'estimate_id', case when (x->>'estimate_id') = any(v_e_final) then x->>'estimate_id' end))).*
      from jsonb_array_elements(v_proj_in) x
     where not ((x->>'id') = any(v_skip_proj_dup))
    on conflict do nothing;
  get diagnostics v_n = row_count;
  v_report := v_report || jsonb_build_object('crm_projects', jsonb_build_object(
    'imported', v_n,
    'skipped', jsonb_array_length(v_proj_in) - v_n,
    'skipped_estimate_already_has_project', to_jsonb(v_skip_proj_dup)));

  -- photo records (files are uploaded to Storage by the app first, never overwriting)
  insert into public.project_photos
    select (jsonb_populate_record(null::public.project_photos, public.import_defaults('project_photos') || jsonb_strip_nulls(x) || jsonb_build_object('org_id', p_org))).*
      from jsonb_array_elements(coalesce(p_data->'project_photos', '[]'::jsonb)) x
     where (x->>'project_id') = any(v_p_final)
    on conflict do nothing;
  get diagnostics v_n = row_count;
  v_total := jsonb_array_length(coalesce(p_data->'project_photos', '[]'::jsonb));
  v_report := v_report || jsonb_build_object('project_photos', jsonb_build_object('imported', v_n, 'skipped', v_total - v_n));

  -- estimate counter: only ever raised
  if (p_data->>'next_estimate_number') ~ '^\d+$' and exists (select 1 from public.org_settings where org_id = p_org) then
    v_report := v_report || jsonb_build_object('next_estimate_number',
      public.raise_estimate_counter(p_org, (p_data->>'next_estimate_number')::integer));
  end if;

  return v_report;
end $$;

revoke all on function public.import_local_data(uuid, jsonb) from public, anon;
revoke all on function public.import_defaults(text) from anon;
grant execute on function public.import_local_data(uuid, jsonb) to authenticated;

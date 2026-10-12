-- TEST ONLY (local PostgreSQL + tests/local_supabase_stub.sql, after all migrations).
-- Checks permissions (RLS), soft delete, versioning, estimate numbering, storage rules and the
-- insert-only data import. Every check raises an error if it fails; the last line prints ALL PASSED.
\set ON_ERROR_STOP 1
set client_min_messages = notice;

-- users: owner, admin, member, outsider (member of another org)
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@evercraft.test'),
  ('00000000-0000-0000-0000-00000000000b', 'admin@evercraft.test'),
  ('00000000-0000-0000-0000-00000000000c', 'member@evercraft.test'),
  ('00000000-0000-0000-0000-00000000000d', 'outsider@other.test');
insert into public.organizations(id, name) values
  ('11111111-1111-1111-1111-111111111111', 'EverCraft'),
  ('22222222-2222-2222-2222-222222222222', 'Other Co');
insert into public.team_members(org_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000a', 'owner'),
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000b', 'admin'),
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000c', 'member'),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-00000000000d', 'owner');

-- helper to act as a user
create function pg_temp.as_user(p uuid) returns void language sql as
  $$ select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false) $$;

-- ===================================================================== import (owner)
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');

-- cloud already has: a category "Roofing" (id cat-cloud), an estimate EST-2026-1001 (id est-cloud)
insert into public.org_settings(org_id, company_name, next_estimate_number)
  values ('11111111-1111-1111-1111-111111111111', 'CLOUD NAME', 1002);
insert into public.categories(org_id, id, name) values ('11111111-1111-1111-1111-111111111111', 'cat-cloud', 'Roofing');
insert into public.estimates(org_id, id, estimate_number, client_name, customer_total)
  values ('11111111-1111-1111-1111-111111111111', 'est-cloud', 'EST-2026-1001', 'Cloud Client', 100);
insert into public.crm_projects(org_id, id, client_name, estimate_id, stage)
  values ('11111111-1111-1111-1111-111111111111', 'crm-cloud', 'Cloud Client', 'est-cloud', 'job');
update public.estimates set crm_project_id = 'crm-cloud' where id = 'est-cloud';

-- the browser's local data (rows in table format, as the app's importer will send them)
select public.import_local_data('11111111-1111-1111-1111-111111111111', $json$
{
 "settings": {"company_name": "LOCAL NAME", "terms": "local terms", "markup": 20, "sales_tax": 0, "tax_mode": "all",
              "company_email": "", "company_phone": "", "company_address": "", "license_number": "", "estimate_footer": "",
              "next_estimate_number": 1001, "extra": {}},
 "categories": [
   {"id": "cat-local-roof", "name": "roofing", "created_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:00:00Z"},
   {"id": "other", "name": "Other Services", "created_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:00:00Z"}],
 "services": [
   {"id": "svc-1", "category": "drywall", "name": "Drywall Repair", "default_price": 4, "description": "", "active": true},
   {"id": "svc-2", "category": "cat-local-roof", "name": "Shingles", "default_price": 45, "description": "", "active": true}],
 "estimates": [
   {"id": "est-cloud", "estimate_number": "EST-2026-1001", "client_name": "LOCAL OVERWRITE ATTEMPT", "customer_total": 999,
    "items": [], "custom_categories": [], "category_totals": {}, "status": "draft", "tax_mode": "all", "address": "", "address_status": "unverified",
    "extra": {}, "version": 1},
   {"id": "est-num-clash", "estimate_number": "EST-2026-1001", "client_name": "Clash", "items": [], "custom_categories": [], "category_totals": {},
    "status": "draft", "tax_mode": "all", "address": "", "address_status": "unverified", "extra": {}, "version": 1},
   {"id": "est-a", "estimate_number": "EST-2026-1002", "date": "2026-09-15", "client_name": "Maria", "client_email": "", "client_phone": "",
    "address": "123 Main St, Apt 4B, Los Angeles, CA 90012, USA", "address_status": "verified", "address_unit": "Apt 4B",
    "address_latitude": 34.05, "address_longitude": -118.24, "address_place_id": "P1",
    "items": [{"id": "li-1", "category": "drywall", "categoryName": "Drywall", "name": "Drywall Repair", "quantity": 500, "price": 4, "total": 2000},
              {"id": "li-2", "category": "cat-local-roof", "categoryName": "Roofing", "name": "Shingles", "quantity": 20, "price": 45, "total": 900}],
    "custom_categories": [{"id": "cat-local-roof", "name": "Roofing"}], "category_totals": {"drywall": 2000, "cat-local-roof": 900},
    "drywall_total": 2000, "other_total": 900, "subtotal": 2900, "markup": 25, "markup_amount": 725, "customer_total": 3625,
    "status": "sent", "tax_mode": "all", "crm_project_id": "crm-a", "extra": {"imported": true, "type": "painting", "area": 1000},
    "version": 1, "created_at": "2026-09-15T08:00:00Z", "updated_at": "2026-09-16T09:30:00Z"},
   {"id": "est-b", "estimate_number": "EST-2026-1003", "client_name": "Links to skipped project", "items": [], "custom_categories": [],
    "category_totals": {}, "status": "draft", "tax_mode": "all", "address": "", "address_status": "unverified",
    "crm_project_id": "crm-dup", "extra": {}, "version": 1}],
 "crm_projects": [
   {"id": "crm-a", "client_name": "Maria", "estimate_id": "est-a", "estimate_number": "EST-2026-1002", "estimate_total": 3625,
    "stage": "started", "prospect_status": "quote_sent", "address": "123 Main St", "address_status": "unverified",
    "tasks": [{"key": "checkTechnician", "group": "before", "label": "Check technician", "done": true}],
    "follow_up_type": "client", "extra": {}, "version": 1, "created_at": "2026-09-15T08:05:00Z", "updated_at": "2026-09-20T12:00:00Z"},
   {"id": "crm-dup", "client_name": "Second project for est-cloud", "estimate_id": "est-cloud", "stage": "lead",
    "prospect_status": "needs_action", "address": "", "address_status": "unverified", "tasks": [], "follow_up_type": "client", "extra": {}, "version": 1},
   {"id": "crm-lead", "client_name": "Lead only", "stage": "followup", "prospect_status": "needs_action", "address": "",
    "address_status": "unverified", "tasks": [], "follow_up_type": "personal", "extra": {}, "version": 1,
    "estimate_id": "est-missing"}],
 "project_photos": [
   {"id": "ph-1", "project_id": "crm-a", "storage_path": "11111111-1111-1111-1111-111111111111/crm-a/ph-1.jpg", "name": "a.jpg", "caption": "Before"},
   {"id": "ph-2", "project_id": "crm-dup", "storage_path": "11111111-1111-1111-1111-111111111111/crm-dup/ph-2.jpg", "name": "b.jpg", "caption": ""}],
 "next_estimate_number": 1010
}
$json$) as report \gset

select set_config('evc.report', :'report', false);

do $$
declare r jsonb := current_setting('evc.report')::jsonb;
begin
  assert r->>'settings' = 'kept existing cloud settings', 'settings must not be overwritten: '||r::text;
  assert (select company_name from public.org_settings) = 'CLOUD NAME', 'cloud settings changed';
  assert (r->'categories'->>'imported')::int = 1 and r->'categories'->'merged_by_name'->>'cat-local-roof' = 'cat-cloud', 'category merge: '||r::text;
  assert (select category from public.services where id = 'svc-2') = 'cat-cloud', 'service should use the cloud category';
  assert (r->'estimates'->>'imported')::int = 2, 'two estimates imported: '||r::text;
  assert (select client_name from public.estimates where id = 'est-cloud') = 'Cloud Client', 'existing estimate overwritten!';
  assert (select customer_total from public.estimates where id = 'est-cloud') = 100, 'existing estimate overwritten!';
  assert r->'estimates'->'skipped_number_in_use'->0->>'id' = 'est-num-clash', 'number clash reported';
  assert not exists (select 1 from public.estimates where id = 'est-num-clash'), 'clashing estimate must be skipped';
  assert r->'crm_projects'->'skipped_estimate_already_has_project'->>0 = 'crm-dup', 'duplicate project skipped: '||r::text;
  assert (select crm_project_id from public.estimates where id = 'est-a') = 'crm-a', 'estimate → project link kept';
  assert (select estimate_id from public.crm_projects where id = 'crm-a') = 'est-a', 'project → estimate link kept';
  assert (select crm_project_id from public.estimates where id = 'est-b') is null, 'link to skipped project dropped (no broken link)';
  assert (select estimate_id from public.crm_projects where id = 'crm-lead') is null, 'link to missing estimate dropped';
  assert (select stage from public.crm_projects where id = 'crm-lead') = 'followup', 'stage kept as stored';
  assert (select updated_at from public.estimates where id = 'est-a') = '2026-09-16T09:30:00Z', 'original updated_at kept';
  assert (select extra->>'area' from public.estimates where id = 'est-a') = '1000', 'extra (old) fields kept';
  assert (select address_unit || '|' || address_place_id from public.estimates where id = 'est-a') = 'Apt 4B|P1', 'address fields kept';
  assert (select items->1->>'categoryName' from public.estimates where id = 'est-a') = 'Roofing', 'line items kept';
  assert (select tasks->0->>'done' from public.crm_projects where id = 'crm-a') = 'true', 'checklist kept';
  assert (r->'project_photos'->>'imported')::int = 1, 'photo of skipped project not imported: '||r::text;
  assert (r->>'next_estimate_number')::int = 1010, 'counter raised to 1010';
  raise notice 'PASS import: insert-only, links valid, conflicts reported';
end $$;

-- re-running the same import changes nothing
select public.import_local_data('11111111-1111-1111-1111-111111111111',
  jsonb_build_object('estimates', jsonb_build_array(jsonb_build_object('id','est-a','estimate_number','EST-2026-1002','client_name','CHANGED',
    'items','[]'::jsonb,'custom_categories','[]'::jsonb,'category_totals','{}'::jsonb,'status','draft','tax_mode','all','address','',
    'address_status','unverified','extra','{}'::jsonb,'version',1)), 'next_estimate_number', 5)) as again \gset
do $$ begin
  assert (select client_name from public.estimates where id = 'est-a') = 'Maria', 're-import must not overwrite';
  assert (select next_estimate_number from public.org_settings) = 1010, 'counter must never go down';
  raise notice 'PASS re-import: nothing overwritten, counter not lowered';
end $$;

-- ===================================================================== member
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
do $$
declare v int; n int;
begin
  assert (select count(*) from public.estimates) = 3, 'member sees org estimates';
  -- edit + version
  select version into v from public.estimates where id = 'est-a';
  update public.estimates set client_name = 'Maria L.' where id = 'est-a' and version = v;
  get diagnostics n = row_count; assert n = 1, 'member can edit';
  assert (select version from public.estimates where id = 'est-a') = v + 1, 'version increased';
  assert (select updated_by from public.estimates where id = 'est-a') = '00000000-0000-0000-0000-00000000000c', 'updated_by set';
  update public.estimates set client_name = 'stale' where id = 'est-a' and version = v;
  get diagnostics n = row_count; assert n = 0, 'stale version update affects 0 rows (conflict detected)';
  -- soft delete denied
  begin
    update public.estimates set deleted_at = now() where id = 'est-a';
    assert false, 'member soft delete should fail';
  exception when insufficient_privilege then null; end;
  -- hard delete impossible
  delete from public.estimates where id = 'est-a';
  get diagnostics n = row_count; assert n = 0, 'no hard delete';
  -- settings read-only
  update public.org_settings set company_name = 'hack';
  get diagnostics n = row_count; assert n = 0, 'member cannot change settings';
  -- team management denied
  begin
    insert into public.team_members(org_id, user_id, role) values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000d', 'admin');
    assert false, 'member cannot add team members';
  exception when insufficient_privilege then null; end;
  -- cannot write into another org
  begin
    insert into public.services(org_id, id, category, name) values ('22222222-2222-2222-2222-222222222222', 'svc-x', 'drywall', 'x');
    assert false, 'member cannot write into another org';
  exception when insufficient_privilege then null; end;
  -- cannot move a record to another org
  begin
    update public.estimates set org_id = '22222222-2222-2222-2222-222222222222' where id = 'est-a';
    assert false, 'org change must fail';
  exception when insufficient_privilege then null; end;
  -- import denied
  begin
    perform public.import_local_data('11111111-1111-1111-1111-111111111111', '{}'::jsonb);
    assert false, 'member cannot import';
  exception when insufficient_privilege then null; end;
  -- stage values are the stored ones
  begin
    update public.crm_projects set stage = 'client_job' where id = 'crm-a';
    assert false, 'unknown stage must be rejected';
  exception when check_violation then null; end;
  -- numbering
  assert public.next_estimate_number('11111111-1111-1111-1111-111111111111', 2026) = 'EST-2026-1010', 'next number';
  assert public.next_estimate_number('11111111-1111-1111-1111-111111111111', 2026) = 'EST-2026-1011', 'numbers never repeat';
  -- storage
  insert into storage.objects(bucket_id, name) values ('crm-photos', '11111111-1111-1111-1111-111111111111/crm-a/ph-9.jpg');
  begin
    insert into storage.objects(bucket_id, name) values ('crm-photos', '22222222-2222-2222-2222-222222222222/x/y.jpg');
    assert false, 'member cannot upload into another org folder';
  exception when insufficient_privilege then null; end;
  delete from storage.objects where name like '11111111%';
  get diagnostics n = row_count; assert n = 0, 'member cannot delete photo files';
  raise notice 'PASS member: edit, versioning, no deletes, no settings/team changes, org isolation, numbering, storage';
end $$;

-- ===================================================================== admin
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$
declare n int;
begin
  update public.estimates set deleted_at = now() where id = 'est-b';
  assert (select deleted_by from public.estimates where id = 'est-b') = '00000000-0000-0000-0000-00000000000b', 'admin soft delete';
  update public.estimates set deleted_at = null where id = 'est-b';
  assert (select deleted_at from public.estimates where id = 'est-b') is null, 'admin restore';
  update public.org_settings set company_name = 'EverCraft Home Improvement';
  get diagnostics n = row_count; assert n = 1, 'admin can change settings';
  delete from public.estimates where id = 'est-b';
  get diagnostics n = row_count; assert n = 0, 'admin cannot hard delete either';
  delete from storage.objects where name = '11111111-1111-1111-1111-111111111111/crm-a/ph-9.jpg';
  get diagnostics n = row_count; assert n = 1, 'admin can purge a photo file';
  raise notice 'PASS admin: soft delete / restore, settings, file purge, no hard delete';
end $$;

-- ===================================================================== owner: team rules
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin
  set constraints public.keep_owner immediate;   -- normally checked at commit
  update public.team_members set role = 'admin'
   where org_id = '11111111-1111-1111-1111-111111111111' and user_id = '00000000-0000-0000-0000-00000000000a';
  assert false, 'last owner must stay';
exception when check_violation then raise notice 'PASS owner: last owner cannot be removed'; end $$;

-- ownership can be handed over within one transaction (promote first, then step down)
begin;
update public.team_members set role = 'owner'
 where org_id = '11111111-1111-1111-1111-111111111111' and user_id = '00000000-0000-0000-0000-00000000000b';
update public.team_members set role = 'admin'
 where org_id = '11111111-1111-1111-1111-111111111111' and user_id = '00000000-0000-0000-0000-00000000000a';
commit;
do $$ begin
  assert (select role from public.team_members where user_id = '00000000-0000-0000-0000-00000000000b'
           and org_id = '11111111-1111-1111-1111-111111111111') = 'owner', 'ownership transferred';
  raise notice 'PASS owner: ownership can be transferred';
end $$;

-- ===================================================================== outsider & anonymous
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
do $$ begin
  assert (select count(*) from public.estimates) = 0, 'outsider sees no EverCraft estimates';
  assert (select count(*) from public.crm_projects) = 0, 'outsider sees no projects';
  assert (select count(*) from public.org_settings) = 0, 'outsider sees no settings';
  assert (select count(*) from storage.objects where bucket_id = 'crm-photos') = 0, 'outsider sees no photos';
  begin
    perform public.next_estimate_number('11111111-1111-1111-1111-111111111111');
    assert false, 'outsider cannot take numbers';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS outsider: sees nothing of EverCraft';
end $$;

reset role;
set role anon;
select pg_temp.as_user(null);
do $$ begin
  begin
    perform count(*) from public.estimates;
    assert false, 'anon must not read';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS anonymous: no access';
end $$;
reset role;
select 'ALL PASSED' as result;

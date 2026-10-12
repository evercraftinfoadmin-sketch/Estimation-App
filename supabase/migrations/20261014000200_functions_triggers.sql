-- Helper functions, audit / version triggers, soft-delete guard, estimate numbering.

-- Is the current user an active member of the organization?
create or replace function public.is_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.team_members m
                 where m.org_id = p_org and m.user_id = auth.uid() and m.active);
$$;

-- Does the current user have one of the given roles in the organization?
create or replace function public.has_role(p_org uuid, p_roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.team_members m
                 where m.org_id = p_org and m.user_id = auth.uid() and m.active and m.role = any(p_roles));
$$;

-- First path segment of a Storage object name as uuid (null if it is not a uuid).
create or replace function public.storage_org(p_name text)
returns uuid language plpgsql immutable as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end $$;

-- created/updated by + timestamps; ids, org and creation data cannot be changed;
-- soft delete / restore (deleted_at) only by owner or admin.
create or replace function public.tg_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    new.updated_by := coalesce(new.updated_by, auth.uid());
    new.created_at := coalesce(new.created_at, now());
    new.updated_at := coalesce(new.updated_at, new.created_at);   -- imports keep their original times
    if new.deleted_at is not null and not public.has_role(new.org_id, array['owner','admin']) then
      raise exception 'Only an owner or admin can delete records' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.org_id is distinct from old.org_id or new.id is distinct from old.id then
    raise exception 'org_id and id cannot be changed' using errcode = '42501';
  end if;
  new.created_at := old.created_at;
  new.created_by := old.created_by;
  new.updated_at := now();
  new.updated_by := auth.uid();
  if new.deleted_at is distinct from old.deleted_at then
    if not public.has_role(new.org_id, array['owner','admin']) then
      raise exception 'Only an owner or admin can delete or restore records' using errcode = '42501';
    end if;
    new.deleted_by := case when new.deleted_at is null then null else auth.uid() end;
  else
    new.deleted_by := old.deleted_by;
  end if;
  return new;
end $$;

-- Optimistic concurrency: every update increases version. The app updates with
-- "... where id = $id and version = $versionItLoaded" and treats 0 rows as an edit conflict.
create or replace function public.tg_bump_version()
returns trigger language plpgsql as $$
begin
  new.version := old.version + 1;
  return new;
end $$;

create or replace function public.tg_settings_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

-- Keep at least one active owner.
create or replace function public.tg_keep_owner()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_org uuid := coalesce(old.org_id, new.org_id);
begin
  if not exists (select 1 from public.team_members
                 where org_id = v_org and role = 'owner' and active) then
    raise exception 'An organization needs at least one active owner' using errcode = '23514';
  end if;
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['categories','services','estimates','crm_projects','project_photos'] loop
    execute format('create trigger audit before insert or update on public.%I
                    for each row execute function public.tg_audit()', t);
  end loop;
  foreach t in array array['estimates','crm_projects'] loop
    execute format('create trigger bump_version before update on public.%I
                    for each row execute function public.tg_bump_version()', t);
  end loop;
end $$;

create trigger settings_audit before update on public.org_settings
  for each row execute function public.tg_settings_audit();

create constraint trigger keep_owner after update or delete on public.team_members
  deferrable initially deferred
  for each row execute function public.tg_keep_owner();

-- Next free estimate number (EST-<year>-<NNNN>), same format as js/settings.js.
-- Atomic: the counter row is locked, so two users can never get the same number.
-- p_year: the user's local year (the app passes it); defaults to the server year.
create or replace function public.next_estimate_number(p_org uuid, p_year integer default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_n integer;
  v_year integer := coalesce(p_year, extract(year from now())::int);
  v_number text;
begin
  if not public.is_member(p_org) then
    raise exception 'Not a member of this organization' using errcode = '42501';
  end if;
  select next_estimate_number into v_n from public.org_settings where org_id = p_org for update;
  if v_n is null then
    raise exception 'Organization settings are missing' using errcode = 'P0002';
  end if;
  loop
    v_number := 'EST-' || v_year || '-' || lpad(v_n::text, 4, '0');
    exit when not exists (select 1 from public.estimates where org_id = p_org and estimate_number = v_number);
    v_n := v_n + 1;
  end loop;
  update public.org_settings set next_estimate_number = v_n + 1 where org_id = p_org;
  return v_number;
end $$;

-- Raise (never lower) the counter, e.g. after importing estimates.
create or replace function public.raise_estimate_counter(p_org uuid, p_next integer)
returns integer language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  if not public.is_member(p_org) then
    raise exception 'Not a member of this organization' using errcode = '42501';
  end if;
  update public.org_settings set next_estimate_number = greatest(next_estimate_number, p_next)
   where org_id = p_org returning next_estimate_number into v;
  return v;
end $$;

revoke all on function public.next_estimate_number(uuid, integer) from public, anon;
revoke all on function public.raise_estimate_counter(uuid, integer) from public, anon;
grant execute on function public.next_estimate_number(uuid, integer) to authenticated;
grant execute on function public.raise_estimate_counter(uuid, integer) to authenticated;

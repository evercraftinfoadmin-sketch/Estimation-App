-- Row Level Security: only active team members see and edit their organization's data.
-- Nobody can hard-delete business records from the app (no DELETE policies); "delete" is a
-- soft delete (deleted_at), which the tg_audit trigger allows only for owners and admins.

alter table public.organizations   enable row level security;
alter table public.team_members    enable row level security;
alter table public.org_settings    enable row level security;
alter table public.categories      enable row level security;
alter table public.services        enable row level security;
alter table public.estimates       enable row level security;
alter table public.crm_projects    enable row level security;
alter table public.project_photos  enable row level security;

-- organizations: members can read their org (orgs are created by the owner in the SQL editor)
create policy org_select on public.organizations for select to authenticated
  using (public.is_member(id));

-- team: members see their team; only owners add, change or remove members
create policy team_select on public.team_members for select to authenticated
  using (public.is_member(org_id));
create policy team_insert on public.team_members for insert to authenticated
  with check (public.has_role(org_id, array['owner']));
create policy team_update on public.team_members for update to authenticated
  using (public.has_role(org_id, array['owner'])) with check (public.has_role(org_id, array['owner']));
create policy team_delete on public.team_members for delete to authenticated
  using (public.has_role(org_id, array['owner']));

-- business settings: members read; owners/admins create and change
create policy settings_select on public.org_settings for select to authenticated
  using (public.is_member(org_id));
create policy settings_insert on public.org_settings for insert to authenticated
  with check (public.has_role(org_id, array['owner','admin']));
create policy settings_update on public.org_settings for update to authenticated
  using (public.has_role(org_id, array['owner','admin'])) with check (public.has_role(org_id, array['owner','admin']));

-- shared business data: members read, add and edit
do $$
declare t text;
begin
  foreach t in array array['categories','services','estimates','crm_projects','project_photos'] loop
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (public.is_member(org_id))', t);
    execute format('create policy %1$s_insert on public.%1$I for insert to authenticated with check (public.is_member(org_id))', t);
    execute format('create policy %1$s_update on public.%1$I for update to authenticated using (public.is_member(org_id)) with check (public.is_member(org_id))', t);
  end loop;
end $$;

-- the anonymous (not logged in) role gets nothing
revoke all on public.organizations, public.team_members, public.org_settings, public.categories,
  public.services, public.estimates, public.crm_projects, public.project_photos from anon;

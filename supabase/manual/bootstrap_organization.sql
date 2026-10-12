-- MANUAL, run once per Supabase project in the SQL editor (dev first), AFTER the migrations
-- and AFTER the owner has signed up / been invited (so the user exists in auth.users).
-- Replace the two placeholders. Creates the organization and makes that user its owner.
-- Business settings are NOT created here: they are uploaded from the app by the data import
-- (or created with the app defaults on the owner's first login).

do $$
declare
  v_owner_email text := 'OWNER_EMAIL@example.com';          -- placeholder
  v_org_name    text := 'EverCraft Home Improvement';
  v_user uuid;
  v_org  uuid;
begin
  select id into v_user from auth.users where lower(email) = lower(v_owner_email);
  if v_user is null then
    raise exception 'No user with email % - invite/sign up the owner first', v_owner_email;
  end if;
  insert into public.organizations(name) values (v_org_name) returning id into v_org;
  insert into public.team_members(org_id, user_id, role, display_name) values (v_org, v_user, 'owner', 'Owner');
  raise notice 'Organization % created, owner %', v_org, v_owner_email;
end $$;

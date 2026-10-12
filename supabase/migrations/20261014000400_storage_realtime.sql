-- Private photo storage and realtime.

-- Private bucket; photos are shown to members through short-lived signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('crm-photos', 'crm-photos', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

-- Objects are stored as <org_id>/<project_id>/<photo_id>.jpg
create policy crm_photos_select on storage.objects for select to authenticated
  using (bucket_id = 'crm-photos' and public.is_member(public.storage_org(name)));
create policy crm_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'crm-photos' and public.is_member(public.storage_org(name)));
-- Files are never overwritten; removing a file (purge) is owner/admin only.
create policy crm_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'crm-photos' and public.has_role(public.storage_org(name), array['owner','admin']));

-- Realtime: other users' changes arrive in the app (RLS still applies to what each user receives).
alter publication supabase_realtime add table
  public.org_settings, public.categories, public.services, public.estimates,
  public.crm_projects, public.project_photos;

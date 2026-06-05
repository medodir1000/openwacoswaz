-- ═══════════════════════════════════════════════════════════════════════
-- Storage RLS — product-images bucket.
--
-- The bucket itself is public (anyone can read via getPublicUrl), but
-- writes (upload/delete) need explicit policies. Folder layout:
--   <seller_id>/<filename>     — uploaded by that seller
--   _admin/<filename>          — uploaded by a platform admin
-- ═══════════════════════════════════════════════════════════════════════

-- Drop legacy policies if any, so this is idempotent on re-run.
drop policy if exists "product_images_seller_insert"  on storage.objects;
drop policy if exists "product_images_seller_select"  on storage.objects;
drop policy if exists "product_images_seller_update"  on storage.objects;
drop policy if exists "product_images_seller_delete"  on storage.objects;
drop policy if exists "product_images_admin_all"      on storage.objects;
drop policy if exists "product_images_public_read"    on storage.objects;

-- Anyone (anon + authenticated) can read objects in product-images.
-- Mirrors the bucket's public=true setting at the policy layer so signed
-- URLs aren't required.
create policy "product_images_public_read" on storage.objects
  for select
  to public
  using (bucket_id = 'product-images');

-- Sellers can write into their OWN seller_id folder.
create policy "product_images_seller_insert" on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = public.current_seller_id()::text
  );

-- Sellers can update their own files (e.g. replace) — needed by the
-- admin UI's "Replace" button.
create policy "product_images_seller_update" on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = public.current_seller_id()::text
  )
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = public.current_seller_id()::text
  );

-- Sellers can delete their own files.
create policy "product_images_seller_delete" on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = public.current_seller_id()::text
  );

-- Platform admins (role='admin' in app_users) get full access for support
-- workflows, AND the _admin/ folder is reserved for admin-only uploads.
create policy "product_images_admin_all" on storage.objects
  for all
  to authenticated
  using (
    bucket_id = 'product-images'
    and public.current_is_admin()
  )
  with check (
    bucket_id = 'product-images'
    and public.current_is_admin()
  );

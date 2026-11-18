-- ============================================================
-- STAGE 2 + 3: COMPLETE THE EXISTING DATABASE (NON-DESTRUCTIVE)
-- Nothing is dropped, truncated or renamed. Existing rows stay.
-- Written from the REAL schema inspected on your project.
-- Safe to re-run (uses IF NOT EXISTS / CREATE OR REPLACE).
-- ============================================================


-- ------------------------------------------------------------
-- A. NEW COLUMNS (missing from your current tables)
-- ------------------------------------------------------------
alter table public.bbq_registrations
  add column if not exists registration_code text,                       -- private code the participant uses to view their dashboard
  add column if not exists approved_by       uuid references auth.users(id),  -- which admin approved
  add column if not exists rejection_reason  text,
  add column if not exists reviewed_at       timestamptz;                -- when approved OR rejected

-- Normal Table accepts any amount; VIP / VIP Plus must match their price.
alter table public.bbq_packages
  add column if not exists allow_custom_amount boolean not null default false;
update public.bbq_packages set allow_custom_amount = true where id = 'normal';

-- Unique private code + one receipt file can only be used once
create unique index if not exists bbq_registrations_code_key
  on public.bbq_registrations (registration_code);
create unique index if not exists bbq_registrations_receipt_key
  on public.bbq_registrations (receipt_path);

-- Helpful indexes for the admin search / filters
create index if not exists bbq_reg_status_idx  on public.bbq_registrations (payment_status);
create index if not exists bbq_reg_package_idx on public.bbq_registrations (package_id);
create index if not exists bbq_reg_phone_idx   on public.bbq_registrations (phone);
create index if not exists bbq_reg_matric_idx  on public.bbq_registrations (matric_number);

-- Data integrity: an approved row ALWAYS has a seat, any other row NEVER has one
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bbq_reg_seat_consistency') then
    alter table public.bbq_registrations
      add constraint bbq_reg_seat_consistency
      check ((payment_status = 'approved') = (seat_number is not null));
  end if;
end $$;


-- ------------------------------------------------------------
-- B. SEAT COUNTERS (makes seat allocation atomic)
-- One row per package. Updating a row locks it, so two admins
-- approving at the same moment can never receive the same seat.
-- ------------------------------------------------------------
create table if not exists public.bbq_seat_counters (
  package_id  text primary key references public.bbq_packages(id),
  prefix      text not null,
  last_number integer not null default 0
);
alter table public.bbq_seat_counters enable row level security;  -- no policies = nobody can touch it directly

insert into public.bbq_seat_counters (package_id, prefix) values
  ('normal','N'), ('vip','V'), ('vipplus','VP')
on conflict (package_id) do nothing;


-- ------------------------------------------------------------
-- C. TABLE PERMISSIONS
-- Your RLS policies exist, but the anon/authenticated roles
-- currently have NO select/insert/update rights, so the website
-- would get "permission denied". We grant the minimum needed.
-- RLS policies still decide which ROWS are visible.
-- ------------------------------------------------------------
grant select on public.bbq_packages, public.bbq_event_settings to anon, authenticated;

-- Admin-only edits (RLS policy is_bbq_admin() enforces who)
grant update (name, price, allow_custom_amount) on public.bbq_packages to authenticated;
grant update (event_name, event_date, venue, account_name, account_number)
  on public.bbq_event_settings to authenticated;

-- Admins read registrations (RLS blocks everyone else). NO direct
-- insert/update/delete on registrations: all writes go through the
-- secure functions below.
grant select on public.bbq_registrations to authenticated;
grant select on public.bbq_admins to authenticated;


-- ------------------------------------------------------------
-- D. SECURE FUNCTIONS (server-side rules the browser cannot bypass)
-- ------------------------------------------------------------

-- D1. Private code generator (internal only)
create or replace function public.bbq_new_code()
returns text language sql volatile set search_path = public as $$
  with u as (select replace(gen_random_uuid()::text, '-', '') as s)
  select upper(substr(s,1,4) || '-' || substr(s,5,4) || '-' || substr(s,9,4)) from u;
$$;

-- D2. Participant submits a registration (no login needed)
create or replace function public.submit_registration(
  p_full_name text, p_phone text, p_matric_number text, p_package_id text,
  p_amount numeric, p_transaction_reference text, p_receipt_path text)
returns jsonb
language plpgsql security definer set search_path = public, storage as $$
declare
  v_pkg   public.bbq_packages%rowtype;
  v_name  text := btrim(coalesce(p_full_name, ''));
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[\s\-]', '', 'g');
  v_matric text := nullif(btrim(coalesce(p_matric_number, '')), '');
  v_ref   text := btrim(coalesce(p_transaction_reference, ''));
  v_code  text := public.bbq_new_code();
begin
  if char_length(v_name) not between 3 and 100 then
    raise exception 'Please enter your full name.' using errcode = '22023';
  end if;
  if v_phone !~ '^(\+234|234|0)[0-9]{10}$' then
    raise exception 'Please enter a valid Nigerian phone number.' using errcode = '22023';
  end if;
  if v_matric is not null and char_length(v_matric) > 30 then
    raise exception 'Matric number is too long.' using errcode = '22023';
  end if;

  select * into v_pkg from public.bbq_packages where id = p_package_id;
  if not found then
    raise exception 'Please choose a valid package.' using errcode = '22023';
  end if;

  if p_amount is null or p_amount <= 0 or p_amount > 10000000 then
    raise exception 'Please enter a valid amount.' using errcode = '22023';
  end if;
  if not v_pkg.allow_custom_amount and p_amount <> v_pkg.price then
    raise exception 'The % amount must be exactly N%.', v_pkg.name, v_pkg.price using errcode = '22023';
  end if;

  if char_length(v_ref) not between 6 and 64 then
    raise exception 'Please enter your OPay transaction reference.' using errcode = '22023';
  end if;

  if p_receipt_path is null
     or p_receipt_path !~ '^receipts/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|pdf)$'
     or not exists (select 1 from storage.objects where bucket_id = 'bbq-receipts' and name = p_receipt_path)
  then
    raise exception 'Please upload your payment receipt.' using errcode = '22023';
  end if;

  begin
    insert into public.bbq_registrations
      (full_name, phone, matric_number, package_id, amount_paid,
       transaction_reference, receipt_path, payment_status, registration_code)
    values
      (v_name, v_phone, v_matric, v_pkg.id, p_amount,
       v_ref, p_receipt_path, 'pending', v_code);
  exception when unique_violation then
    raise exception 'This transaction reference or receipt was already submitted.' using errcode = '23505';
  end;

  return jsonb_build_object('registration_code', v_code);
end $$;

-- D3. Participant views ONLY their own registration, using their private code
create or replace function public.get_registration_by_code(p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  select jsonb_build_object(
           'registration_code',     r.registration_code,
           'full_name',             r.full_name,
           'phone',                 r.phone,
           'matric_number',         r.matric_number,
           'package_name',          p.name,
           'amount_paid',           r.amount_paid,
           'transaction_reference', r.transaction_reference,
           'payment_status',        r.payment_status,
           'seat_number',           r.seat_number,
           'rejection_reason',      r.rejection_reason,
           'submitted_at',          r.submitted_at,
           'approved_at',           r.approved_at)
    into v
    from public.bbq_registrations r
    join public.bbq_packages p on p.id = r.package_id
   where r.registration_code = upper(btrim(coalesce(p_code, '')));
  return v;  -- null when the code does not exist
end $$;

-- D4. ADMIN: approve payment + atomic seat allocation
create or replace function public.approve_registration(p_registration_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r        public.bbq_registrations%rowtype;
  v_n      integer;
  v_prefix text;
  v_seat   text;
begin
  if not public.is_bbq_admin() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;

  select * into r from public.bbq_registrations where id = p_registration_id for update;
  if not found then
    raise exception 'Registration not found.' using errcode = 'P0002';
  end if;
  if r.payment_status = 'approved' then
    return jsonb_build_object('seat_number', r.seat_number, 'already_approved', true);
  end if;

  insert into public.bbq_seat_counters (package_id, prefix)
  values (r.package_id, upper(r.package_id))
  on conflict (package_id) do nothing;

  -- this UPDATE locks the package's counter row until commit
  update public.bbq_seat_counters
     set last_number = last_number + 1
   where package_id = r.package_id
  returning last_number, prefix into v_n, v_prefix;

  v_seat := v_prefix || '-' || lpad(v_n::text, 3, '0');

  update public.bbq_registrations
     set payment_status   = 'approved',
         seat_number      = v_seat,
         approved_by      = auth.uid(),
         approved_at      = now(),
         reviewed_at      = now(),
         rejection_reason = null
   where id = r.id;

  return jsonb_build_object('seat_number', v_seat, 'already_approved', false);
end $$;

-- D5. ADMIN: reject payment (no seat; record is kept)
create or replace function public.reject_registration(p_registration_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.bbq_registrations%rowtype;
begin
  if not public.is_bbq_admin() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;

  select * into r from public.bbq_registrations where id = p_registration_id for update;
  if not found then
    raise exception 'Registration not found.' using errcode = 'P0002';
  end if;
  if r.payment_status <> 'pending' then
    raise exception 'Only pending payments can be rejected.' using errcode = '22023';
  end if;

  update public.bbq_registrations
     set payment_status   = 'rejected',
         rejection_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         approved_by      = auth.uid(),
         reviewed_at      = now()
   where id = r.id;

  return jsonb_build_object('status', 'rejected');
end $$;

-- D6. ADMIN: dashboard numbers (always computed live from the database)
create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_bbq_admin() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
      'total_registrations', count(*),
      'approved',            count(*) filter (where payment_status = 'approved'),
      'pending',             count(*) filter (where payment_status = 'pending'),
      'rejected',            count(*) filter (where payment_status = 'rejected'),
      'confirmed_revenue',   coalesce(sum(amount_paid) filter (where payment_status = 'approved'), 0))
    from public.bbq_registrations);
end $$;


-- ------------------------------------------------------------
-- E. WHO MAY CALL WHAT
-- ------------------------------------------------------------
revoke execute on function public.bbq_new_code()                       from public, anon, authenticated;
revoke execute on function public.rls_auto_enable()                    from public, anon, authenticated;
revoke execute on function public.is_bbq_admin()                       from public, anon;

revoke execute on function public.submit_registration(text,text,text,text,numeric,text,text) from public;
revoke execute on function public.get_registration_by_code(text)       from public;
revoke execute on function public.approve_registration(uuid)           from public, anon;
revoke execute on function public.reject_registration(uuid,text)       from public, anon;
revoke execute on function public.admin_dashboard_stats()              from public, anon;

grant execute on function public.submit_registration(text,text,text,text,numeric,text,text) to anon, authenticated;
grant execute on function public.get_registration_by_code(text)        to anon, authenticated;
grant execute on function public.approve_registration(uuid)            to authenticated;
grant execute on function public.reject_registration(uuid,text)        to authenticated;
grant execute on function public.admin_dashboard_stats()               to authenticated;
grant execute on function public.is_bbq_admin()                        to authenticated;


-- ------------------------------------------------------------
-- F. PRIVATE RECEIPT STORAGE
-- The bucket 'bbq-receipts' is already private (2 MB, JPG/PNG/WEBP/PDF).
-- We keep it and tighten the upload rule so visitors can only
-- create files named receipts/<uuid>.<jpg|jpeg|png|webp|pdf>.
-- They still cannot read, list, overwrite or delete anything.
-- ------------------------------------------------------------
drop policy if exists "Visitors upload BBQ receipts" on storage.objects;
create policy "Visitors upload BBQ receipts" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'bbq-receipts'
    and name ~ '^receipts/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|pdf)$'
  );
-- "Admins view BBQ receipts" (select, is_bbq_admin()) is kept as it is.


-- ------------------------------------------------------------
-- G. EVENT DETAIL TOUCH-UP (optional, one row)
-- ------------------------------------------------------------
update public.bbq_event_settings
   set venue = 'IBBUL, Lapai Staff Quarters, Niger State, Nigeria'
 where id = 1 and venue = 'IBBUL, Lapai Staff Quarters';


-- ------------------------------------------------------------
-- H. MAKE YOURSELF AN ADMIN (run AFTER creating your admin user)
-- 1. Dashboard > Authentication > Users > Add user (email + password,
--    tick "Auto confirm user").
-- 2. Replace the email below and run ONLY this statement:
--
-- insert into public.bbq_admins (user_id)
-- select id from auth.users where email = 'YOUR-ADMIN-EMAIL@example.com'
-- on conflict do nothing;
-- ------------------------------------------------------------

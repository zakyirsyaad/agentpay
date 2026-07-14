-- I-006-C: allow a freshly verified production tenant to coexist with the
-- quarantined legacy identity for the same owner address.
-- The partial unique index preserves one active verified tenant per owner
-- while keeping legacy audit rows immutable and isolated.

begin;

alter table public.verified_owner_identities
  drop constraint if exists verified_owner_identities_owner_address_key;

create unique index if not exists verified_owner_identities_verified_owner_idx
  on public.verified_owner_identities (lower(owner_address))
  where status = 'VERIFIED';

notify pgrst, 'reload schema';

commit;

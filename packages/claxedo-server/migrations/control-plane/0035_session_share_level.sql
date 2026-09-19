-- What a share grants: `follow` reads and streams, `send` also prompts the
-- agent and answers its permission and question prompts. A row with no level
-- is not a row whose sender was vetted, so the default reads as `follow` and
-- the send capability is re-granted deliberately, behind the dialog's
-- disclosure.
--
-- `session_share_intent_immutable` lists the columns a grant may not be
-- rewritten under; `level` is deliberately not one of them, because moving a
-- live grant between levels is the downgrade control.
alter table session_share_grants
  add column level text not null default 'follow'
  check (level in ('follow', 'send'));

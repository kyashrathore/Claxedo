-- A session share holder's Runtime Access Token reaches the one session the
-- share names and nothing else of the workspace; a token with no session is
-- the workspace owner's.
alter table runtime_access_tokens add column session_id text;

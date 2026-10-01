-- The session share that admitted a share holder's Runtime Access Token.
-- Revoking that share, or ending the team membership it reached the holder
-- through, revokes exactly the tokens it admitted, whoever its target reaches
-- by then. A workspace token, and a session token its owner minted, has none.
alter table runtime_access_tokens add column share_grant_id text;

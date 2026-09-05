-- Dynamically registered MCP OAuth clients (RFC 7591).
--
-- Context7's Clerk tenant and Composio's login host both advertise a
-- `registration_endpoint` and support NEITHER a pre-registered client nor a
-- client-id metadata document, so the only way this deployment can hold an
-- OAuth client identity with them is to register one and remember it. A
-- registration that is not remembered is not a registration: every discovery
-- would mint a new client id, orphaning the previous one at the authorization
-- server and invalidating every refresh token issued under it.
--
-- The row is DEPLOYMENT-WIDE, not tenant-scoped: `issuer` is the primary key,
-- so one Claxedo client exists per authorization server and every org and user
-- of this deployment authorizes through it. That is what the authorization
-- server models too — the client is the application, and the per-user grant is
-- the connection row in `hosted_connections`. Two concurrent discoveries race
-- to `insert ... on conflict (issuer) do nothing`; the loser reads the winner's
-- row, so the deployment converges on exactly one client per issuer.
--
-- No secret material lives here. `token_endpoint_auth_method: "none"` is what
-- both live targets issue, so `client_secret_ref` is usually null; when a
-- server DOES issue a secret it is written to the envelope-encrypted credential
-- store (`hostedOrgCredentials`) and only the opaque provider id is recorded in
-- this column. `registration_json` is the authorization server's registration
-- response with `client_secret` and `registration_access_token` stripped, kept
-- so a later audit can see the exact terms this client was issued under.
create table mcp_oauth_clients (
  issuer text primary key,
  client_id text not null,
  client_secret_ref text,
  registration_json text not null check (json_valid(registration_json)),
  registered_at integer not null
);

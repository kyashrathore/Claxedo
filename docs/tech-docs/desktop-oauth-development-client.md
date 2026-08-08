# Desktop OAuth development client

Status: **registered and validated** (U8 Unit 6 prerequisite, 2026-08-08).

## Why this document exists

The package-split plan makes Electron main the sole owner of the desktop
account session, using a Clerk **public** OAuth client with Authorization Code
+ PKCE. It also states that before Unit 6 may freeze `AccountPort` or the
machine-enrollment APIs, a production-like spike against a registered
development application must prove the design — and that a failure "rejects the
Electron-native Clerk design and blocks Units 6 and 9–11".

This records the registration half of that spike, so the next pass starts from
a working client instead of a dashboard task.

## The development client

| Field | Value |
|---|---|
| Name | Claxedo Desktop |
| Client ID | `jtPpxdXd8RbC1aqP` |
| Public client | yes — no secret is used |
| Issuer | `https://suitable-elf-22.clerk.accounts.dev` |
| Discovery | `https://suitable-elf-22.clerk.accounts.dev/.well-known/openid-configuration` |
| Redirect URIs | `claxedo://auth/callback`, `claxedo-beta://auth/callback`, `claxedo-dev://auth/callback` |

Only the client ID and the issuer/discovery origin enter the desktop build, per
U8-R7. Both are non-secret, which is why they are written down here.

**Clerk returns a `client_secret` even for a public application. The desktop
must never read it.** A public client authenticates by proving possession of
the PKCE verifier, and a secret shipped inside a desktop binary is not a
secret — it is a string every user has a copy of. If a secret ever appears in
the desktop build or its environment, the client has been misconfigured as
confidential and the whole credential boundary is void.

## What the issuer actually supports

Read from the live discovery document rather than assumed:

- `code_challenge_methods_supported: ["S256"]` — PKCE with SHA-256, which is
  what the plan specifies. Plain is not offered, so there is no weaker method
  to fall back to by accident.
- `grant_types_supported: ["authorization_code", "refresh_token"]` — the
  authorization-code exchange and the refresh the plan's restart-restoration
  path depends on.
- `authorization_endpoint`: `.../oauth/authorize`
- `token_endpoint`: `.../oauth/token`
- `jwks_uri`: `.../.well-known/jwks.json`

That is the full set of primitives Unit 6's Electron adapter needs, and none of
them had to be worked around.

## What this does NOT yet prove

The plan's spike also requires, against this application: system-browser
authorization, exact callback dispatch to the registered scheme, refresh,
restart restoration, provider logout/revocation, organization
switching/removal, and rejection of cancel/timeout/replay. Every one of those
needs the Electron adapter to exist — they are properties of the implementation
driving this client, not of the client itself.

Beta and production channels also need their own registered applications before
promotion. This is the development instance only (`sk_test_`/`pk_test_`).

## Reproducing or rotating

Created through Clerk's Backend API with the development secret key:

```bash
curl -X POST -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Claxedo Desktop","redirect_uris":["claxedo://auth/callback","claxedo-beta://auth/callback","claxedo-dev://auth/callback"],"scopes":"profile email","public":true}' \
  https://api.clerk.com/v1/oauth_applications
```

`GET /v1/oauth_applications` lists what exists; the application is deletable, so
this is reversible.

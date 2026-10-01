# Deploy Claxedo to your own Cloudflare

One command puts Claxedo on your Cloudflare account: the control plane Worker, its two D1 databases, GitHub
sign-in, and the web app on your own domain. Your team signs in, you claim the deployment as its owner, and
everyone works from the same place. Re-run the same command to upgrade.

## Before you start

- A Cloudflare account with a zone for your domain. Claxedo uses two hostnames on it, for example
  `api.example.com` for the control plane and `app.example.com` for the web app. Both Workers attach to them as
  custom domains; `*.workers.dev` and `*.pages.dev` hostnames are refused.
- Wrangler signed in to that account: `./node_modules/.bin/wrangler login` from `packages/claxedo-server`, or
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment.
- A GitHub OAuth app of your own with the callback URL `https://api.example.com/api/auth/callback/github`.
- A deployed Workspace Relay (step 2), which carries live sessions between machines and browsers.
- A clone of this repository with `bun install` run at its root, and `bun run build:packages` once.

Run every command below from `packages/claxedo-server`.

## 1. Create the deployment's keys

```bash
mkdir -p ~/.claxedo-deploy && cd ~/.claxedo-deploy
openssl genpkey -algorithm ed25519 -out runtime-access.pem
openssl pkey -in runtime-access.pem -pubout -out runtime-access.pub.pem
openssl genpkey -algorithm ed25519 -out relay-host.pem
openssl pkey -in relay-host.pem -pubout -out relay-host.pub.pem
openssl rand -hex 32 > relay-resolver-token
cd -
```

## 2. Deploy the Workspace Relay

The relay is its own Worker (`packages/workspace-relay`). Give it the resolver token, the relay host signing key,
and the runtime-access public key; Wrangler offers to create the `claxedo-relay` Worker on the first secret:

```bash
cd ../workspace-relay
../claxedo-server/node_modules/.bin/wrangler secret put CLAXEDO_RELAY_RESOLVER_TOKEN --name claxedo-relay < ~/.claxedo-deploy/relay-resolver-token
../claxedo-server/node_modules/.bin/wrangler secret put CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM --name claxedo-relay < ~/.claxedo-deploy/relay-host.pem
../claxedo-server/node_modules/.bin/wrangler secret put CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM --name claxedo-relay < ~/.claxedo-deploy/runtime-access.pub.pem
```

Attach `relay.example.com` to `claxedo-relay` as a custom domain (Workers & Pages → `claxedo-relay` → Settings →
Domains & Routes), then deploy it; the script waits until the relay answers there:

```bash
CLAXEDO_RELAY_WORKER_NAME=claxedo-relay \
CLAXEDO_RELAY_URL=https://relay.example.com \
CLAXEDO_RELAY_CENTRAL_URL=https://api.example.com \
CLAXEDO_RELAY_APP_ORIGINS=https://app.example.com \
  ./node_modules/.bin/tsx scripts/deploy-cloudflare.ts
cd ../claxedo-server
```

## 3. Deploy Claxedo

Put the settings in a private shell (or your secret manager) and run the deploy:

```bash
export CLAXEDO_API_ORIGIN=https://api.example.com
export CLAXEDO_APP_ORIGIN=https://app.example.com
export CLAXEDO_WORKSPACE_RELAY_URL=https://relay.example.com
export CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME='Acme'
export GITHUB_CLIENT_ID='<your GitHub OAuth app client ID>'
export GITHUB_CLIENT_SECRET='<your GitHub OAuth app client secret>'
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
export CLAXEDO_AUTH_INTROSPECTION_SECRET="$(openssl rand -hex 32)"
export CLAXEDO_RELAY_RESOLVER_TOKEN="$(cat ~/.claxedo-deploy/relay-resolver-token)"
export CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM="$(cat ~/.claxedo-deploy/runtime-access.pem)"
export CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM="$(cat ~/.claxedo-deploy/runtime-access.pub.pem)"
export CLAXEDO_RELAY_HOST_VERIFY_PEM="$(cat ~/.claxedo-deploy/relay-host.pub.pem)"

bun run deploy:user-cloudflare -- --dry-run   # the plan, and an offline bundle of the Worker
bun run deploy:user-cloudflare
```

Keep `BETTER_AUTH_SECRET` and `CLAXEDO_AUTH_INTROSPECTION_SECRET`: every later deploy needs the same two values.

The deploy:

1. finds the D1 databases `claxedo-auth` and `claxedo-control-plane`, and creates them the first time;
2. applies their migrations and provisions the CLI and desktop OAuth clients;
3. builds the web app against your API origin;
4. deploys the `claxedo` Worker on `api.example.com` with every secret in the environment, and waits until
   `https://api.example.com/health` names the version it just deployed;
5. deploys the `claxedo-app` Worker with the web app on `app.example.com`, and waits until it serves that build.

It stops before publishing if a required secret is neither in the environment nor already on the Worker.

## 4. Claim the deployment

Sign in at `https://app.example.com` with GitHub, then make that account the owner:

```bash
bun run deploy:user-cloudflare:claim-owner -- --email you@example.com
```

The command registers a one-hour, one-use owner claim bound to that account and prints one line to paste into the
developer console of the app tab you signed in with. The line answers `200` once you own the deployment; reload
the app. Invite your team from there.

## Upgrade

Pull the new version and run `bun run deploy:user-cloudflare` again with the same settings. Migrations only move
forward, the OAuth clients are upserted, and the Worker and the app are replaced in place.

## Roll back

Cloudflare keeps every deployed version. Roll the Worker back with
`./node_modules/.bin/wrangler rollback --name claxedo` (and `--name claxedo-app` for the web app). D1 schema changes
are forward-only; restore data to a point in time with
`./node_modules/.bin/wrangler d1 time-travel restore claxedo-control-plane --timestamp <time>`.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `CLAXEDO_API_ORIGIN`, `CLAXEDO_APP_ORIGIN` | required | Custom-domain origins of the control plane and the web app. |
| `CLAXEDO_WORKSPACE_RELAY_URL` | required | Origin of your Workspace Relay. |
| `CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME` | required | Your organization's display name. |
| `CLAXEDO_AUTH_METHODS` | `github` | `github`, `google`, or `github,google`; each needs its `*_CLIENT_ID` and `*_CLIENT_SECRET`. |
| `CLAXEDO_WORKER_NAME` | `claxedo` | The control plane Worker. |
| `CLAXEDO_APP_WORKER_NAME` | `<worker>-app` | The web app Worker. |
| `CLAXEDO_DEPLOYMENT_ID`, `CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID` | the Worker name | Stable identities stored with your data; never change them after the first deploy. |
| `CLAXEDO_AUTH_D1_DATABASE_NAME`, `CLAXEDO_CONTROL_PLANE_D1_DATABASE_NAME` | `<worker>-auth`, `<worker>-control-plane` | The two D1 databases. |
| `CLAXEDO_DOCUMENTS_BUCKET` | `<worker>-documents` | The R2 bucket Pages are stored in; create it with `wrangler r2 bucket create`. |

`--agent-plugins` deploys the Agent Plugins build, which adds team plugins from one repository. It binds the R2
bucket `CLAXEDO_AGENT_PLUGINS_BUCKET` (default `<worker>-agent-plugins`, created with
`wrangler r2 bucket create`) and needs a `CLAXEDO_CREDENTIALS_KEK` secret (`openssl rand -base64 32`). With
`CLAXEDO_SANDBOX_POSTURE=full-hosted` and `CLAXEDO_SANDBOX_DRIVER` it also runs cloud workspaces in your sandbox
provider; see [Sandbox egress](./sandbox-egress.md).

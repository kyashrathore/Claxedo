export const cloudflareDeploymentPrompt = `Deploy Claxedo to my Cloudflare account from this repository.

Begin with a read-only preflight. Inspect the current repository documentation, packages/claxedo-server/wrangler.toml, the Worker entrypoint, required Cloudflare bindings, deployment workflows, and supported runtime and relay compositions. Treat the checked-in implementation as the source of truth.

Before changing or deploying anything:

1. Confirm that I have the Claxedo repository, Git, Bun, Wrangler, and a coding agent that can inspect and run commands in the checkout.
2. Confirm that I am authenticated to the intended Cloudflare account and that the account has permission to create Workers, R2 buckets, Durable Objects, and Cron Triggers.
3. Explain exactly which Claxedo components will run in Cloudflare and which components require a connected relay, workspace runtime, local machine, server, or sandbox provider. Never imply that terminals, files, processes, or arbitrary coding-agent execution run inside the control-plane Worker.
4. Produce a prerequisite table with four states: already configured, can be generated safely, requires a choice from me, and requires a secret from me.
5. Include identity and JWKS configuration, workspace authority, relay URL, runtime-access signing keys, resolver and admin tokens, web application deployment, runtime placement, AI-provider credentials, and sandbox-provider credentials in that table.
6. Ask for one missing decision or secret at a time. Never echo, log, commit, or place secrets in command arguments.
7. Explain any resource that may create a bill before creating it and wait for my approval.
8. Run the relevant tests, the Worker import-graph verification, and a Wrangler dry run before deploying.

After preflight succeeds:

1. Create or bind the required Cloudflare resources using the repository configuration.
2. Generate cryptographically secure signing keys and internal service tokens where the repository supports doing so.
3. Configure secrets through Wrangler or the appropriate provider secret store.
4. Deploy the Claxedo control plane and web application from one reviewed repository revision.
5. Connect the selected workspace authority, relay, and local or sandbox runtime.
6. Verify health, mode, compatibility, JWKS, authentication, workspace registration, relay connectivity, session admission, terminal access, and WorkGraph.
7. Stop if a required path cannot be verified. Describe partial deployments precisely rather than calling them complete.

Finish with the deployed URLs, the repository revision, where every component runs, verification results, unresolved or optional integrations, estimated recurring infrastructure costs, upgrade instructions, and exact rollback and teardown commands.

Never weaken authentication, expose an unsigned service publicly, invent missing infrastructure, or bypass a failing security check.`

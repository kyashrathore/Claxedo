# Claxedo Server Scripts

Scripts are operator commands. Behavior proof belongs in Vitest or Playwright,
not in source-text audits or evidence manifests.

## `release/`

Publishes the public `@claxedo` npm packages and refuses a publish when a
package already on npm changed without a version bump. Sandbox images do not
consume these artifacts.

## `sandbox/`

Builds sandbox images from the repository: `build-sandbox-image.ts` esbuilds
the in-repo workspace-runtime host into `.build/`, which the Dockerfiles copy.
`cloudflare-worker/` is the Cloudflare Sandbox Worker that runs that image.

A control plane deployed with `--agent-plugins` requires an image built with
`--agent-plugins`, whose host mounts the runtime apply route. The
`claxedo-sandbox-image` workflow accepts `agent_plugins=true` for this variant.
It publishes the content-addressed image without changing `latest`; pin the
matching staging or production deployment explicitly to the emitted image tag.

Repository preparation resumes an interrupted initial checkout, including an
empty `git init` that has not yet recorded its origin. It refuses that origin
configuration when the unfinished checkout contains files, indexed work, or
another remote. A checkout with a commit retains the person's existing work.

## `deploy/`

Runs hosted deploy commands and Worker-safety checks. These scripts deploy or
dry-run deploy targets; they do not run smoke tests or browser tests.

## `maintenance/`

Operator jobs against a deployed control plane, such as draining a retired
credential KEK from the hosted credential store.

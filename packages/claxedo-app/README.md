# Claxedo app

The Claxedo app, for the web and, through `packages/claxedo-desktop`, the desktop. The rules for working here are in `AGENTS.md`.

- `bun run dev` serves the web app on port 4445 against the local daemon.
- `bun run typecheck`, `bun run build`, `bun run check`.
- `bun run e2e` runs the end-to-end flows.
- `perf-harness/` holds the agent-app-benchmark driver; `bun run test:perf-harness` verifies it (see its `README.md`).

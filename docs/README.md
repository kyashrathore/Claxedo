# Claxedo Docs

A doc belongs here only while it is canonical for architecture that is still
live and accurate against the code, an operational runbook that is still used,
or a plan whose work is queued or in progress. Reviews, audits, execution logs,
verification evidence and shipped plans are deleted; git history keeps them.
Source code and tests do not read or cite these docs.

- [Architecture](./architecture/) — the embedded OpenCode SDK contract and the
  runtime recovery contract.
- [Tech docs](./tech-docs/) — the access model, workspaces on a host, the
  desktop hosted-operation matrix, and the transcript typography matrix.
- [Staging branch](./deploy/staging-branch.md) — how `staging` deploys.
- [Pi native harness user guide](./pi-native-user-guide.md)
- [Security: open findings](./security-open-findings.md)
- [Making Claxedo lighter](./perf/README.md) — what made the app cheaper to
  download, start and switch, plus [agent learnings](./perf/AGENTS.md) for
  attempts that already failed.
- [Plans](./plans/README.md)

Operational runbooks for the deployed control plane and relay live in
[`public-docs/`](../public-docs/README.md).

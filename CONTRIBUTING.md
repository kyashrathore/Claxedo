# Contributing to Claxedo

Thanks for your interest in contributing. Claxedo is a hard fork of [OpenCode](https://github.com/anomalyco/opencode) — the engine and shared UI packages are vendored in-repo as first-party source, and everything else (control plane, workspace runtime, relay, channels, connections, workgraph, web/desktop apps) is Claxedo's own.

## Before you start

- For small fixes (typos, docs, obvious bugs), feel free to open a PR directly.
- For anything larger — new features, UI changes, architecture changes — please open an issue first so we can discuss the approach before you invest time in an implementation.
- Check open issues and PRs to avoid duplicate work.

## Development setup

```sh
bun install
bun run dev:desktop    # desktop shell
bun typecheck          # turbo typecheck across the workspace
```

See [README.md](./README.md) for the package layout and [claxedo.com/framework](https://claxedo.com/framework) for architecture and deployment guides.

## Submitting a pull request

- Keep PRs focused — one logical change per PR.
- Include a clear description of what changed and why (see the PR template).
- Include screenshots or recordings for UI changes.
- Make sure `bun typecheck` passes before requesting review.
- Note any deliberate deviations from the vendored OpenCode engine packages (`packages/{opencode,core,server,protocol,schema,plugin,llm,codemode,tui,ui,session-ui,sdk,http-recorder}`) — these are bumped deliberately, not synced via merge, so changes there need extra care.

## Reporting bugs

Please use the [bug report template](./.github/ISSUE_TEMPLATE/bug-report.yml) and include steps to reproduce, what you expected, and what actually happened.

## Code of conduct

Be respectful and constructive. We reserve the right to close issues/PRs and block participants who are abusive or acting in bad faith.

## Security issues

Do not open a public issue for security vulnerabilities — see [SECURITY.md](./SECURITY.md) instead.

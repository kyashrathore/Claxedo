# Agent Runtime Stats share Worker

Cloudflare Worker embedded in the `@claxedo/agent-runtime-stats` package. It publishes immutable aggregate runtime-placement reports and stores only session/turn placement, coverage, repeat-machine demand, full-machine return intervals, and observed-span aggregates in D1. Raw transcripts, prompts, paths, tool inputs, and user identifiers are outside the API contract.

The CLI opens `claxedo.com/agent-runtime-share#data=…`; URL fragments are not sent in HTTP requests. The browser renders the complete report, and **Save page and share on X** creates its permanent `claxedo.com/r/:id` URL before opening the X composer. Each saved page includes X/Open Graph metadata whose PNG is rendered by the Cloudflare Browser Run binding and stored in D1.

```sh
bun run worker:test
bun run worker:typecheck
bunx wrangler d1 migrations apply agent-runtime-stats-reports --remote --config worker/wrangler.jsonc
bun run worker:deploy
```

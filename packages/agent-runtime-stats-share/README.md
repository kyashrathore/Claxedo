# Agent Runtime Stats share Worker

Cloudflare Worker for publishing immutable aggregate runtime reports. It stores only the six public metrics in D1. Raw transcripts, prompts, paths, tool inputs, and user identifiers are outside the API contract.

The CLI opens `/share#data=…`; URL fragments are not sent in HTTP requests. The browser reviews the local payload and uploads it only after **Publish anonymous snapshot** is pressed. Each resulting `/r/:id` page includes X/Open Graph metadata whose PNG is rendered by the Cloudflare Browser Run binding and stored in D1.

```sh
bun run test
bun run typecheck
bunx wrangler d1 migrations apply agent-runtime-stats-reports --remote
bun run deploy
```

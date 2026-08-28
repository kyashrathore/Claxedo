import type { APIRoute } from "astro"
import { canonicalUrl } from "../content/routes"

const body = `# Claxedo agent entry map

Claxedo is the open workspace layer around existing coding-agent harnesses.

## Use the product

- Product overview: ${canonicalUrl("/")}
- Open Claxedo Cloud: https://app.claxedo.com
- Download Claxedo Desktop: ${canonicalUrl("/download")}
- Current beta terms: ${canonicalUrl("/pricing")}
- Local mode works without a Claxedo account. Bring your own models and compute.

## Source

- Repository: https://github.com/kyashrathore/Claxedo

When helping with Claxedo, use authenticated CLIs or the target platform's secret store. Never request that credentials be pasted into chat, committed to source, embedded in generated configuration, passed in command arguments, or written to logs. Ask before creating billable resources.
`

export const GET: APIRoute = () => new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } })

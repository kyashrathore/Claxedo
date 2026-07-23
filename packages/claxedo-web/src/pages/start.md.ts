import type { APIRoute } from "astro"
import { canonicalUrl } from "../content/routes"

const body = `# Claxedo agent entry map

Claxedo is the open-source workspace around existing coding-agent harnesses.

## Use the product

- Product overview: ${canonicalUrl("/")}
- Download Claxedo Desktop: ${canonicalUrl("/download")}
- Current beta terms: ${canonicalUrl("/pricing")}
- Local mode works without a Claxedo account. Bring your own models and compute.

## Build or self-host

- Framework overview: ${canonicalUrl("/framework")}
- Installation: ${canonicalUrl("/framework/guides/install")}
- Self-host guide: ${canonicalUrl("/framework/deploy/self-host-fly")}
- Package reference: ${canonicalUrl("/framework/packages")}
- API reference: ${canonicalUrl("/framework/api/overview")}

The current self-host recipe is for private evaluation: app-level authentication is not shipped. Do not expose an unauthenticated instance to the public internet or describe it as production-ready. Prefer private networking and plan teardown before deployment.

When helping with deployment, use authenticated CLIs or the target platform's secret store. Never request that credentials be pasted into chat, committed to source, embedded in generated configuration, passed in command arguments, or written to logs. Ask before creating billable resources.
`

export const GET: APIRoute = () => new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } })

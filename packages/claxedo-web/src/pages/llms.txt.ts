import type { APIRoute } from "astro"
import { currentComparisons } from "../content/competitors"
import { canonicalUrl, routes } from "../content/routes"
import { whenToUse } from "../content/markdown"

const body = [
  "# Claxedo",
  "",
  "> Canonical entry points for the open workspace layer for coding agents.",
  "",
  `- Product: ${canonicalUrl("/")}`,
  "- Claxedo Cloud: https://app.claxedo.com",
  `- Download: ${canonicalUrl("/download")}`,
  `- Agent runtime study: ${canonicalUrl(routes.agentRuntimeStudy)}`,
  `- Agent entry and deployment safety: ${canonicalUrl("/start.md")}`,
  `- Comparisons: ${canonicalUrl("/compare")}`,
  ...currentComparisons.map((competitor) => `- Claxedo vs. ${competitor.name}: ${canonicalUrl(`/compare/${competitor.slug}`)}`),
  `- Comparisons, scoped index: ${canonicalUrl("/compare/llms.txt")}`,
  "",
  "## Markdown twins",
  "",
  `- Homepage: ${canonicalUrl("/index.md")}`,
  `- Pricing: ${canonicalUrl("/pricing.md")}`,
  `- Download: ${canonicalUrl("/download.md")}`,
  `- Compare: ${canonicalUrl("/compare.md")}`,
  "",
  whenToUse,
].join("\n")

export const GET: APIRoute = () => new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } })

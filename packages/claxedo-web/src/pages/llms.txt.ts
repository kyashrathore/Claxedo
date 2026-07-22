import type { APIRoute } from "astro"
import { currentComparisons } from "../content/competitors"
import { canonicalUrl } from "../content/routes"

const body = [
  "# Claxedo",
  "",
  "> Canonical entry points for the connected, open-source coding-agent workspace.",
  "",
  `- Product: ${canonicalUrl("/")}`,
  `- Download: ${canonicalUrl("/download")}`,
  `- Framework: ${canonicalUrl("/framework")}`,
  `- Agent entry and deployment safety: ${canonicalUrl("/start.md")}`,
  `- Guide: ${canonicalUrl("/framework/guides/introduction")}`,
  `- API reference: ${canonicalUrl("/framework/api/overview")}`,
  `- Self-host: ${canonicalUrl("/framework/deploy/self-host-fly")}`,
  `- Comparisons: ${canonicalUrl("/compare")}`,
  ...currentComparisons.map((competitor) => `- Claxedo vs. ${competitor.name}: ${canonicalUrl(`/compare/${competitor.slug}`)}`),
  "",
].join("\n")

export const GET: APIRoute = () => new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } })

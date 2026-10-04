import type { APIRoute } from "astro"
import { currentComparisons } from "../../content/competitors"
import { canonicalUrl, routes } from "../../content/routes"

const body = [
  "# Claxedo comparisons",
  "",
  "> Scoped index of the maintained, sourced comparison pages.",
  "",
  `- Overview: ${canonicalUrl(routes.compare)}`,
  `- Markdown overview: ${canonicalUrl(`${routes.compare}.md`)}`,
  ...currentComparisons.map((c) => `- Claxedo vs. ${c.name}: ${canonicalUrl(`${routes.compare}/${c.slug}`)}`),
  "",
].join("\n")

export const GET: APIRoute = () => new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } })

import { z } from "zod"
import type { McpToolResult } from "../mcp-tool"
import type { McpToolAccess, McpToolContext } from "../context"
import type { ToolRegistrar } from "./registry"

const YOUCOM_ENDPOINT = "https://api.you.com/v1/agents/search"
const DEFAULT_MAX = 5
const MAX_RESULTS = 10

const ACCESS: McpToolAccess = { audiences: ["user", "runtime"], write: false, scope: "read" }

interface YoucomResult {
	title: string
	url: string
	description?: string
}

interface YoucomResponse {
	results?: { web?: YoucomResult[] }
}

/**
 * Searches the web via You.com's keyless free-tier API (100 searches/day per
 * IP, no key). Returns ranked results with titles, URLs, and descriptions as
 * plain text for the agent to read.
 *
 * MINIMAL: no keyed endpoint or retry logic — the free tier is the ceiling.
 * Upgrade path: set YDC_API_KEY and switch to https://ydc-index.io/v1/search
 * with X-Api-Key for higher limits.
 */
export function registerYouSearchTools(registry: ToolRegistrar): void {
	registry.tool(
		"you_web_search",
		{
			description:
				"Search the web using You.com's keyless search API (100 searches/day per IP, no key required). Returns ranked web results with titles, URLs, and descriptions.",
			inputSchema: {
				query: z.string().min(1).describe("The search query"),
				max_results: z
					.number()
					.int()
					.min(1)
					.max(MAX_RESULTS)
					.optional()
					.describe("Maximum number of results (default 5)"),
			},
			access: ACCESS,
		},
		async (args, _ctx: McpToolContext): Promise<McpToolResult> => {
			const max = args.max_results ?? DEFAULT_MAX
			const url = new URL(YOUCOM_ENDPOINT)
			url.searchParams.set("query", args.query)
			url.searchParams.set("max_results", String(max))

			try {
				const response = await fetch(url)
				if (!response.ok) {
					return {
						content: [{ type: "text" as const, text: `You.com search failed (${response.status} ${response.statusText})` }],
						isError: true,
					}
				}
				// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- response.json() returns unknown; the shape is validated by the API contract
				const data = (await response.json()) as YoucomResponse
				const results = data.results?.web ?? []
				if (results.length === 0) {
					return { content: [{ type: "text" as const, text: "No results found." }] }
				}
				const lines = results.map(
					(r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.description ? `\n   ${r.description}` : ""}`,
				)
				return { content: [{ type: "text" as const, text: lines.join("\n\n") }] }
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: `You.com search error: ${String(error)}` }],
					isError: true,
				}
			}
		},
	)
}
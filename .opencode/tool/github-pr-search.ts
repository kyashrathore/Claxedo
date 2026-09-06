/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
async function githubFetch(endpoint: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      // `HeadersInit` also covers `string[][]`, which spreads into an object as
      // numeric indices. Normalizing through Headers keeps caller overrides
      // winning (they come last) without depending on the input's shape.
      ...Object.fromEntries(new Headers(options.headers).entries()),
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

type PR = {
  title: string
  html_url: string
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

/** The search hits this tool renders; a row missing either field is dropped. */
function pullRequests(input: unknown): PR[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => {
    if (!isRecord(item)) return []
    const { title, html_url } = item
    return typeof title === "string" && typeof html_url === "string" ? [{ title, html_url }] : []
  })
}

export default tool({
  description: `Use this tool to search GitHub pull requests by title and description.

This tool searches PRs in the anomalyco/opencode repository and returns LLM-friendly results including:
- PR number and title
- Author
- State (open/closed/merged)
- Labels
- Description snippet

Use the query parameter to search for keywords that might appear in PR titles or descriptions.`,
  args: {
    query: tool.schema.string().describe("Search query for PR titles and descriptions"),
    limit: tool.schema.number().describe("Maximum number of results to return").default(10),
    offset: tool.schema.number().describe("Number of results to skip for pagination").default(0),
  },
  async execute(args) {
    const owner = "anomalyco"
    const repo = "opencode"

    const page = Math.floor(args.offset / args.limit) + 1
    const searchQuery = encodeURIComponent(`${args.query} repo:${owner}/${repo} type:pr state:open`)
    const result = await githubFetch(
      `/search/issues?q=${searchQuery}&per_page=${args.limit}&page=${page}&sort=updated&order=desc`,
    )

    const search = isRecord(result) ? result : {}
    const total = typeof search.total_count === "number" ? search.total_count : 0
    if (total === 0) {
      return `No PRs found matching "${args.query}"`
    }

    const prs = pullRequests(search.items)

    if (prs.length === 0) {
      return `No other PRs found matching "${args.query}"`
    }

    const formatted = prs.map((pr) => `${pr.title}\n${pr.html_url}`).join("\n\n")

    return `Found ${total} PRs (showing ${prs.length}):\n\n${formatted}`
  },
})

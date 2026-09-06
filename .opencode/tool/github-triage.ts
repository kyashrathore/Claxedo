/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"

/** Declared as a tuple so the tool's argument enum is derived, not asserted. */
const TEAM_NAMES = ["tui", "desktop_web", "core", "inference", "windows"] as const

const TEAM = {
  tui: ["kommander", "simonklee"],
  desktop_web: ["Hona", "Brendonovich"],
  core: ["jlongster", "rekram1-node", "nexxeln", "kitlangton", "starptech"],
  inference: ["fwang", "MrMushrooooom", "starptech"],
  windows: ["Hona"],
} as const satisfies Record<(typeof TEAM_NAMES)[number], readonly string[]>

function pick<T>(items: readonly T[]) {
  return items[Math.floor(Math.random() * items.length)]
}

function getIssueNumber(): number {
  const issue = parseInt(process.env.ISSUE_NUMBER ?? "", 10)
  if (!issue) throw new Error("ISSUE_NUMBER env var not set")
  return issue
}

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

export default tool({
  description: `Use this tool to assign a GitHub issue.

Provide the team that should own the issue. This tool picks a random assignee from that team and does not apply labels.`,
  args: {
    team: tool.schema.enum(TEAM_NAMES).describe("The owning team"),
  },
  async execute(args) {
    const issue = getIssueNumber()
    const owner = "anomalyco"
    const repo = "opencode"
    const assignee = pick(TEAM[args.team])

    await githubFetch(`/repos/${owner}/${repo}/issues/${issue}/assignees`, {
      method: "POST",
      body: JSON.stringify({ assignees: [assignee] }),
    })

    return `Assigned @${assignee} from ${args.team} to issue #${issue}`
  },
})

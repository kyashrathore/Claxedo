/**
 * What one session changed on disk.
 *
 * This is the whole review surface: no file read, no search, no git status.
 * Every harness already has those tools, and duplicating them spends the
 * model's context on a second way to do what it can already do. What no
 * harness can answer is "what did that other session touch", which is the
 * working tree of the session's own directory — a worktree session's changes
 * are not the project checkout's.
 */
import { z } from "zod"
import { asRecord } from "@claxedo/helpers/guards"
import { num, records, text } from "../json"
import type { ToolRegistrar } from "./registry"
import { declaredToolAccess } from "./inventory"
import { targetScope, toolTarget, toolText, WORKSPACE_TARGET_SCHEMA } from "./target"

const DIFF_MODES = ["uncommitted", "staged", "unstaged"] as const

type FileChange = Readonly<{ file: string; additions: number; deletions: number; status?: string }>

const STATUS_LETTER: Readonly<Record<string, string>> = { added: "A", deleted: "D", modified: "M" }

export function registerReviewTools(registry: ToolRegistrar) {
  registry.tool(
    "session_changes",
    {
      description:
        "Summarize what one session changed in its working directory: the files it touched with added and removed line counts. Returns counts, never file contents or patches.",
      inputSchema: {
        session: z.string().trim().min(1).describe("Session id."),
        ...WORKSPACE_TARGET_SCHEMA,
        mode: z.enum(DIFF_MODES).optional().describe("Which changes to summarize. Defaults to uncommitted."),
      },
      access: declaredToolAccess({ audiences: ["user"], write: false, scope: "read" }),
    },
    async (args, ctx) => {
      const target = toolTarget(ctx, args)
      const server = await ctx.client.server(target)
      const session = asRecord((await server.session.get({ sessionID: args.session, ...targetScope(target) })).data)
      const directory = text(session?.directory)
      const mode = args.mode ?? "uncommitted"
      const changes = fileChanges(
        await server.diff.vcs({ content: "summary", mode, ...(directory ? { directory } : {}) }),
      )
      return toolText(renderChanges(args.session, text(session?.title), directory, mode, changes))
    },
  )
}

function fileChanges(value: unknown): readonly FileChange[] {
  return records(value).flatMap((row) => {
    const file = text(row.file)
    if (!file) return []
    return [{ file, additions: num(row.additions) ?? 0, deletions: num(row.deletions) ?? 0, ...(text(row.status) ? { status: text(row.status) } : {}) }]
  })
}

function renderChanges(sessionId: string, title: string | undefined, directory: string | undefined, mode: string, changes: readonly FileChange[]) {
  const named = title ? `${sessionId} "${title}"` : sessionId
  const where = directory ? ` in ${directory}` : ""
  if (changes.length === 0) return `${named} has no ${mode} changes${where}.`
  const additions = changes.reduce((total, change) => total + change.additions, 0)
  const deletions = changes.reduce((total, change) => total + change.deletions, 0)
  return [
    `${named}${where} — ${changes.length} ${changes.length === 1 ? "file" : "files"}, +${additions} -${deletions} (${mode})`,
    ...changes.map((change) => `  ${STATUS_LETTER[change.status ?? ""] ?? " "} ${change.file} +${change.additions} -${change.deletions}`),
  ].join("\n")
}

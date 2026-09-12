import {
  HEAVY_WORKSPACE_REOPEN_FILE_PATHS,
  HEAVY_WORKSPACE_FILE_LINES,
  HEAVY_WORKSPACE_EXPANDED_DIFF_LINES,
} from "./scenarios/heavy-workspace-reopen-contract"
import {
  SESSION_SWITCH_SUBSTANTIAL_FILE_PATH,
  type StabilityRequestCounts,
} from "./scenarios/session-switch-workspace-contract"
import type { ScenarioId, SeedManifest } from "../types"
import {
  WORKSPACE_INTERACTIONS_LARGE_FILE_PATH,
  WORKSPACE_INTERACTIONS_LARGE_FILE_LINES,
  WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS,
  WORKSPACE_INTERACTIONS_OPEN_FILE_PATH,
  WORKSPACE_INTERACTIONS_FILE_LINES,
  WORKSPACE_INTERACTIONS_EXPAND_DIFF_INDEX,
  WORKSPACE_INTERACTIONS_EXPAND_DIFF_LINES,
  WORKSPACE_INTERACTIONS_LARGE_DIFF_INDEX,
  WORKSPACE_INTERACTIONS_LARGE_DIFF_LINES,
} from "./scenarios/workspace-interactions-contract"
import path from "node:path"

type SessionRenderer = "plain" | "markdown" | "code" | "mermaid" | "diff"

export function changedFilesForVcs(url: URL, fixture: Pick<ReturnType<typeof fixtureFor>, "changedFiles">) {
  if (url.searchParams.get("content") !== "summary") return fixture.changedFiles
  return fixture.changedFiles.map((item) => ({
    file: item.file,
    status: item.status,
    additions: item.additions,
    deletions: item.deletions,
  }))
}

export function fileContent(url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const file = url.searchParams.get("path") ?? fixture.changedFiles[0]?.file ?? "src/generated/file-0.ts"
  const heavyWorkspace =
    fixture.scenario === "heavy-workspace-reopen" ||
    fixture.scenario === "heavy-workspace-review-resume" ||
    fixture.scenario === "heavy-workspace-close"
  if (heavyWorkspace && HEAVY_WORKSPACE_REOPEN_FILE_PATHS.some((path) => path === file)) {
    return { type: "text", content: generatedFileContent(file, HEAVY_WORKSPACE_FILE_LINES) }
  }
  if (fixture.scenario === "workspace-interactions") {
    if (file === WORKSPACE_INTERACTIONS_LARGE_FILE_PATH) {
      return { type: "text", content: generatedFileContent(file, WORKSPACE_INTERACTIONS_LARGE_FILE_LINES) }
    }
    const substantial = [...WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS, WORKSPACE_INTERACTIONS_OPEN_FILE_PATH]
    if (substantial.some((path) => path === file)) {
      return { type: "text", content: generatedFileContent(file, WORKSPACE_INTERACTIONS_FILE_LINES) }
    }
  }
  if (fixture.scenario === "session-switch-workspace" && file === SESSION_SWITCH_SUBSTANTIAL_FILE_PATH) {
    return { type: "text", content: generatedFileContent(file, HEAVY_WORKSPACE_FILE_LINES) }
  }
  return { type: "text", content: `export const perfFile = ${JSON.stringify(file)}\n` }
}

function generatedFileContent(file: string, lines: number) {
  const content = Array.from(
    { length: lines },
    (_, index) => `export const perfValue${index} = ${JSON.stringify(`${file}:${index}`)}`,
  ).join("\n")
  return `${content}\n`
}

export function fixtureFor(scenario: ScenarioId, seed: SeedManifest) {
  const directory = `/tmp/claxedo-perf/${scenario}`
  const workspaceDirectories = Array.from({ length: Math.max(1, seed.projects) }, (_, index) =>
    index === 0 ? directory : `${directory}/workspace-${index + 1}`,
  )
  const providerID = "opencode"
  const modelID = "claude-opus-4-6"
  const sessions = Array.from({ length: Math.max(2, seed.sessions || 1) }, (_, index) => ({
    id: `ses_perf_${scenario.replace(/-/g, "_")}_${index}`,
    slug: `perf-${index}`,
    projectID: `proj_perf_${scenario.replace(/-/g, "_")}`,
    // session-switch-workspace needs sessions distributed across two distinct
    // workspace directories, exactly like the workspace-switch flow.
    directory: scenario === "workspace-switch" || scenario === "session-switch-workspace"
      ? workspaceDirectories[index % workspaceDirectories.length]
      : directory,
    title: `${scenario} session ${index + 1}`,
    version: "dev",
    time: { created: 1_700_000_000_000 + index, updated: 1_700_000_010_000 + index },
  }))
  const project = {
    id: `proj_perf_${scenario.replace(/-/g, "_")}`,
    worktree: directory,
    vcs: "git",
    name: scenario,
    time: { created: 1_700_000_000_000, updated: 1_700_000_010_000 },
    sandboxes: workspaceDirectories.slice(1),
    workspaces: Object.fromEntries(workspaceDirectories.map((dir, index) => [
      dir,
      {
        kind: "local",
        workspace_name: index === 0 ? "main" : `workspace ${index + 1}`,
        available: true,
      },
    ])),
  }
  return {
    scenario,
    directory,
    workspaceDirectories,
    project,
    projects: [project],
    path: { state: directory, config: directory, worktree: directory, directory, home: "/tmp" },
    provider: {
      all: [
        {
          id: providerID,
          name: "OpenCode",
          source: "api",
          env: [],
          options: {},
          models: {
            [modelID]: {
              id: modelID,
              providerID,
              name: "Claude Opus 4.6",
              family: "claude-4",
              release_date: "2026-01-01",
              attachment: true,
              reasoning: true,
              temperature: true,
              tool_call: true,
              limit: { context: 200_000, output: 64_000 },
              options: {},
              cost: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
              status: "active",
            },
          },
        },
      ],
      connected: [providerID],
      default: { [providerID]: modelID },
    },
    sessions,
    changedFiles: Array.from({ length: Math.max(1, seed.changed_files) }, (_, index) => {
      const heavyExpandedDiff =
        index === 0 && (
          scenario === "heavy-workspace-reopen" ||
          scenario === "heavy-workspace-review-resume" ||
          scenario === "heavy-workspace-close"
        )
      // The isolated-interaction families size their diffs from the contract:
      // a substantial expand target at index 0 and a much-larger-than-median
      // diff at the large index (workspace-lifecycle keeps only the expand
      // target so its above-fold content carries real weight).
      const isolatedFamily =
        scenario === "workspace-lifecycle" ||
        scenario === "workspace-interactions" ||
        scenario === "session-switch-workspace"
      const substantialLines = heavyExpandedDiff
        ? HEAVY_WORKSPACE_EXPANDED_DIFF_LINES
        : isolatedFamily && index === WORKSPACE_INTERACTIONS_EXPAND_DIFF_INDEX
          ? WORKSPACE_INTERACTIONS_EXPAND_DIFF_LINES
          : isolatedFamily && scenario !== "workspace-lifecycle" && index === WORKSPACE_INTERACTIONS_LARGE_DIFF_INDEX
            ? WORKSPACE_INTERACTIONS_LARGE_DIFF_LINES
            : undefined
      return {
        file: `src/generated/file-${index}.ts`,
        status: substantialLines !== undefined ? "modified" : index % 11 === 0 ? "added" : "modified",
        additions: substantialLines ?? (index % 9) + 1,
        deletions: substantialLines ?? index % 3,
        patch: substantialLines !== undefined
          ? heavyWorkspaceExpandedPatch(substantialLines)
          : `@@ -1 +1 @@\n-export const value = ${index}\n+export const value = ${index + 1}`,
      }
    }),
    terminals: Array.from({ length: Math.max(1, seed.terminals || 1) }, (_, index) => ({
      id: `pty_perf_${scenario.replace(/-/g, "_")}_${index}`,
      title: `Terminal ${index + 1}`,
    })),
    totalMessages: seed.messages,
    // These messages are an imported snapshot, with no replay events in this
    // fixture. The message endpoint must report that authoritative watermark
    // even when a page has no older-history cursor.
    maxEventOrdinal: 0,
    goalState: {
      capabilities: {
        implemented: false,
        available: false,
        unavailableReason: "The opencode fixture does not implement Goals",
        actions: [],
        recovery: "blocked" as const,
        optionalFields: [],
      },
      goal: null,
    },
    sessionRenderer: sessionRenderer(scenario),
    requestCounts: {
      messages: 0,
      messagesBySession: {} as Record<string, number>,
      expectedTranscripts: {} as Record<string, string>,
      visibleTranscripts: {} as Record<string, boolean>,
      // Mock-authoritative counters for the session-switch stability gates:
      // the route handler (the producer of every response) classifies each
      // request, so a workspace/VCS refetch cannot hide from an in-page
      // observer window.
      stability: { vcs: 0, file: 0, workspace: 0, sse: 0 } as StabilityRequestCounts,
    },
    visualFailures: [] as string[],
  }
}

function heavyWorkspaceExpandedPatch(lines: number) {
  const before = Array.from({ length: lines }, (_, index) => `-export const oldValue${index} = ${index}`)
  const after = Array.from({ length: lines }, (_, index) => `+export const newValue${index} = ${index + 1}`)
  return [`@@ -1,${lines} +1,${lines} @@`, ...before, ...after].join("\n")
}

// The synthetic transcript's identity convention, in one place: the page
// selector needs to map a cursor back to an index, and `message()` needs to
// stamp the same ids and roles the selector reasoned about.
const PERF_MESSAGE_ID_PREFIX = "msg_perf_"

export function perfMessageID(index: number) {
  return `${PERF_MESSAGE_ID_PREFIX}${index}`
}

export function perfMessageIndex(id: string) {
  if (!id.startsWith(PERF_MESSAGE_ID_PREFIX)) return undefined
  const value = Number(id.slice(PERF_MESSAGE_ID_PREFIX.length))
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

export function perfMessageRole(index: number): "user" | "assistant" {
  return index % 2 === 0 ? "user" : "assistant"
}

export function message(
  sessionID: string,
  index: number,
  directory: string,
  sessionTitle: string | undefined,
  renderer: ReturnType<typeof sessionRenderer>,
) {
  const id = perfMessageID(index)
  const role = perfMessageRole(index)
  const model = { providerID: "opencode", modelID: "claude-opus-4-6" }
  const tokens = {
    input: 800 + index * 13,
    output: role === "assistant" ? 240 + index * 7 : 0,
    reasoning: role === "assistant" ? 32 : 0,
    cache: { read: index * 3, write: role === "assistant" ? 4 : 0 },
  }
  return {
    info: {
      id,
      sessionID,
      role,
      time: {
        created: 1_700_000_000_000 + index * 1000,
        ...(role === "assistant" ? { completed: 1_700_000_000_500 + index * 1000 } : {}),
      },
      agent: "build",
      ...(role === "user"
        ? { model }
        : {
            parentID: perfMessageID(Math.max(0, index - 1)),
            path: { cwd: directory, root: directory },
            modelID: model.modelID,
            providerID: model.providerID,
            mode: "build",
            cost: Number((0.0025 + index * 0.0001).toFixed(4)),
            tokens,
          }),
    },
    parts: messageParts({ sessionID, messageID: id, index, role, sessionTitle, renderer }),
  }
}

function messageParts(input: {
  sessionID: string
  messageID: string
  index: number
  role: "user" | "assistant"
  sessionTitle?: string
  renderer: ReturnType<typeof sessionRenderer>
}) {
  const rich = input.role === "assistant" && input.index % 8 === 7
  const text = {
    id: `part_perf_${input.index}`,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "text" as const,
    text: rich ? rendererText(input.renderer, input.index, input.sessionTitle ?? input.sessionID) :
      `${input.role} message ${input.index}${input.sessionTitle ? ` for ${input.sessionTitle}` : ""}\n\n${"sample output ".repeat(40 + (input.index % 20))}`,
  }
  if (input.renderer !== "diff" || !rich) return [text]

  const before = Array.from({ length: 240 }, (_, line) => `export const value${line} = ${line}`).join("\n")
  const after = Array.from({ length: 240 }, (_, line) => `export const value${line} = ${line + 1}`).join("\n")
  return [
    {
      id: `part_perf_tool_${input.index}`,
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "tool" as const,
      callID: `call_perf_tool_${input.index}`,
      tool: "edit",
      state: {
        status: "completed" as const,
        input: {
          filePath: `src/generated/session-${input.index}.ts`,
          oldString: before,
          newString: after,
        },
        output: "File edited successfully",
        title: `Edit src/generated/session-${input.index}.ts`,
        metadata: {
          filediff: {
            file: `src/generated/session-${input.index}.ts`,
            before,
            after,
            additions: 240,
            deletions: 240,
          },
        },
        time: { start: 1_700_000_000_000 + input.index * 1000, end: 1_700_000_000_500 + input.index * 1000 },
      },
    },
    text,
  ]
}

export function sessionRenderer(scenario: ScenarioId): SessionRenderer {
  // The flick needs tall, unequal rows — a markdown body with a 40-row table
  // next to a one-line turn — because a uniform-height list hides exactly the
  // band-too-small failure it measures.
  if (scenario === "transcript-flick") return rendererOverride() ?? "markdown"
  if (scenario !== "session-switch") return "plain"
  return rendererOverride() ?? "diff"
}

function rendererOverride(): SessionRenderer | undefined {
  const value = process.env.CLAXEDO_PERF_SESSION_RENDERER
  if (value === "plain" || value === "markdown" || value === "code" || value === "mermaid" || value === "diff") {
    return value
  }
  return undefined
}

function rendererText(renderer: ReturnType<typeof sessionRenderer>, index: number, sessionLabel: string) {
  if (renderer === "markdown") {
    return [
      `# Renderer profile ${sessionLabel} ${index}`,
      "",
      "This fixture exercises **strong text**, _emphasis_, `inline code`, and [a link](https://example.com).",
      "",
      ...Array.from(
        { length: 40 },
        (_, row) => `- ${sessionLabel} item ${row}: ${"rendered markdown content ".repeat(4)}`,
      ),
      "",
      "| Name | State | Detail |",
      "| --- | --- | --- |",
      ...Array.from(
        { length: 40 },
        (_, row) => `| ${sessionLabel}-row-${row} | ready | ${"table value ".repeat(4)} |`,
      ),
    ].join("\n")
  }
  if (renderer === "code") {
    return [
      "```typescript",
      `export const session = ${JSON.stringify(sessionLabel)}`,
      ...Array.from({ length: 240 }, (_, row) => `export const value${row} = (input: number) => input + ${row}`),
      "```",
    ].join("\n")
  }
  if (renderer === "mermaid") {
    return [
      "```mermaid",
      "flowchart LR",
      `  session[${sessionLabel.replace(/[^a-zA-Z0-9 ]/g, " ")}] --> node0[Step 0]`,
      ...Array.from({ length: 60 }, (_, row) => `  node${row}[Step ${row}] --> node${row + 1}[Step ${row + 1}]`),
      "```",
    ].join("\n")
  }
  return `assistant message ${index}\n\n${"sample output ".repeat(60)}`
}

export function workspaceLabel(fixture: ReturnType<typeof fixtureFor>, directory: string) {
  if (directory === fixture.directory) return "main"
  return fixture.project.workspaces[directory]?.workspace_name ?? path.basename(directory)
}

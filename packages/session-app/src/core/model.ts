/**
 * The session model — Elm-shaped on purpose.
 *
 * This file is the L1 layer from the dual-target plan (sub-plan 03): plain
 * TypeScript in the cores subset, no DOM, no imports beyond siblings. The
 * browser runs it as-is; the Native SDK build compiles it. Rows are derived
 * INSIDE the fold so views on both targets stay dumb — a view only ever maps
 * `rows` to widgets and dispatches messages.
 */

import type { RuntimeNoticeSeverity, RuntimeStatus, RuntimeToolStatus } from "./events"

export type TimelineRow =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; markdown: string; streaming: boolean }
  | { kind: "thinking"; id: string; markdown: string; streaming: boolean }
  | {
      kind: "tool"
      id: string
      toolCallId: string
      name: string
      status: RuntimeToolStatus
      summary?: string
      error?: string
    }
  | { kind: "notice"; id: string; severity: RuntimeNoticeSeverity; message: string }
  | { kind: "plan"; id: string; markdown: string; complete: boolean }
  | { kind: "todos"; id: string; todos: Array<{ id: string; description: string; status: string }> }

export type ConnectionState = "connecting" | "live" | "closed" | "error"

export type SessionModel = {
  sessionId: string
  directory: string
  title?: string
  status: RuntimeStatus
  connection: ConnectionState
  rows: TimelineRow[]
  draft: string
  /** Set while a submitted prompt is awaiting the turn to start. */
  sending: boolean
  lastError?: string
  composer: ComposerModel
}

/** A transcript message as returned by `GET /session/:id/message`, decoded tolerantly. */
export type TranscriptMessage = {
  id: string
  role: "user" | "assistant"
  text: string
}

// ---------------------------------------------------------------------------
// Composer state — harness / model / effort / permission mode / project /
// worktree selection, shaped after the data the real local server serves
// (see src/client/composer-client.ts for the routes and decoders).
// ---------------------------------------------------------------------------

/** One harness in the roster (e.g. claude-acp, opencode). */
export type HarnessSummary = { id: string; name: string; active?: boolean }

/** The `{providerID, modelID}` pair the prompt body carries. */
export type ModelRef = { providerID: string; modelID: string }

export type ModelOption = {
  providerID: string
  modelID: string
  name: string
  description?: string
}

/** A reasoning-effort level ("thought_level" category / model variant). */
export type EffortOption = { id: string; name: string }

export type PermissionModeOption = {
  id: string
  name: string
  description?: string
  level?: string
}

/** A project/workspace from `GET /api/claxedo/workspace`. */
export type WorkspaceSummary = {
  workspaceId: string
  directory: string
  access: "local" | "cloud" | "user-hosted"
  name?: string
  branch?: string
}

export type WorktreeSummary = { name: string; branch: string; directory: string }

export type ComposerResource =
  | "roster"
  | "models"
  | "modes"
  | "workspaces"
  | "worktrees"
  | "worktree-create"

// The selection fields carry `| undefined` explicitly (not just `?`) because
// update arms CLEAR them by assigning undefined in an object spread, which
// exactOptionalPropertyTypes otherwise rejects.
export type ComposerModel = {
  harnesses: HarnessSummary[]
  selectedHarness?: string | undefined
  models: ModelOption[]
  selectedModel?: ModelRef | undefined
  efforts: EffortOption[]
  selectedEffort?: string | undefined
  permissionModes: PermissionModeOption[]
  selectedMode?: string | undefined
  /** Set when the selected harness has no permission-mode surface at all. */
  modesUnsupported?: string | undefined
  workspaces: WorkspaceSummary[]
  /** Directory of the chosen project/workspace; unset means the session's own. */
  selectedWorkspace?: string | undefined
  worktrees: string[]
  selectedWorktree?: string | undefined
  creatingWorktree: boolean
  lastError?: string | undefined
}

export function initComposerModel(): ComposerModel {
  return {
    harnesses: [],
    models: [],
    efforts: [],
    permissionModes: [],
    workspaces: [],
    worktrees: [],
    creatingWorktree: false,
  }
}

/** The directory a NEW session (or worktree listing) should target. */
export function composerDirectory(model: SessionModel): string {
  return model.composer.selectedWorktree ?? model.composer.selectedWorkspace ?? model.directory
}

export type SessionMsg =
  | { type: "RuntimeEvent"; event: { type: string } & Record<string, unknown> }
  | { type: "TranscriptLoaded"; messages: TranscriptMessage[] }
  | { type: "ConnectionChanged"; state: ConnectionState }
  | { type: "DraftEdited"; text: string }
  | { type: "SubmitPrompt" }
  | { type: "PromptAccepted"; userMessageId?: string }
  | { type: "PromptFailed"; error: string }
  // Composer: load flows (shell feeds fetch results back as these) …
  | { type: "ComposerOpened" }
  | { type: "RosterLoaded"; harnesses: HarnessSummary[] }
  | { type: "ModelsLoaded"; harness: string; models: ModelOption[]; efforts?: EffortOption[]; defaultModel?: ModelRef }
  | { type: "ModesLoaded"; harness: string; modes: PermissionModeOption[]; currentModeId?: string; unsupported?: string }
  | { type: "WorkspacesLoaded"; workspaces: WorkspaceSummary[] }
  | { type: "WorktreesLoaded"; directory: string; worktrees: string[] }
  | { type: "WorktreeCreated"; worktree: WorktreeSummary }
  | { type: "ComposerLoadFailed"; resource: ComposerResource; error: string }
  // … and selection flows.
  | { type: "SelectHarness"; harness: string }
  | { type: "SelectModel"; model: ModelRef }
  | { type: "SelectEffort"; effort: string }
  | { type: "SelectMode"; modeId: string }
  | { type: "SelectWorkspace"; directory: string }
  | { type: "SelectWorktree"; directory: string }
  | { type: "CreateWorktree"; name?: string }

/**
 * Side effects the shells execute. `update` never performs I/O — it returns
 * the effect and the shell (web or native) runs it through its ports, feeding
 * results back as messages. This is the seam that keeps the core identical on
 * both targets.
 *
 * `send-prompt` carries the composer's full selection; the field names mirror
 * the server's `SessionPromptBody` (`model`, `agent`, `variant`,
 * `permissionMode`) so the shell can pass them straight to the client.
 */
export type SessionEffect =
  | {
      kind: "send-prompt"
      sessionId: string
      directory: string
      text: string
      model?: ModelRef
      agent?: string
      variant?: string
      permissionMode?: string
    }
  | { kind: "load-roster"; directory: string }
  | { kind: "load-models"; directory: string; harness: string }
  | { kind: "load-modes"; directory: string; harness: string }
  | { kind: "load-workspaces" }
  | { kind: "load-worktrees"; directory: string }
  | { kind: "create-worktree"; directory: string; name?: string }

export type UpdateResult = { model: SessionModel; effects: SessionEffect[] }

export function initSessionModel(input: { sessionId: string; directory: string; title?: string }): SessionModel {
  return {
    sessionId: input.sessionId,
    directory: input.directory,
    ...(input.title !== undefined ? { title: input.title } : {}),
    status: "idle",
    connection: "connecting",
    rows: [],
    draft: "",
    sending: false,
    composer: initComposerModel(),
  }
}

import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { skipToken, useQuery } from "@tanstack/solid-query"
import type { SessionRequestsQueryData, SnapshotFileDiff, Todo } from "@/features/session/data/sync/queries"
import { registeredConversationLastUserMessageAt } from "@/features/session/conversation/conversation-registry"
import { subscribeSessionActivity } from "@/features/session/store/session-status-dispatcher"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { formatCompactAge } from "@/lib/relative-time"
import { signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"
import { isRelayHostKind } from "@/platform/runtime/placement-wire"
import { workspaceVcsQuery } from "@/platform/runtime/workspace-query"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import type { SwitcherCardDetails, SwitcherStatus } from "../compact-switcher/switcher-items"
import type { ContentMeta } from "../state/index"
import type { ProjectItem } from "./domain-types"

/**
 * What the compact tab's hover card shows beyond the tab itself, read only
 * while the card is open. Call it from the card's body: every query and
 * subscription below belongs to the card and ends when it closes.
 *
 * Nothing here asks a model. Status, todo and changes come from the session's
 * own cache entries, which the event stream keeps current and this card never
 * fetches; only the branch may be read once for a directory that nothing has
 * warmed, and the vcs query holds it for the rest of the app's life.
 */
export function useSwitcherCardDetails(input: {
  meta: ContentMeta | undefined
  status: Accessor<SwitcherStatus | undefined>
  projects: Accessor<readonly ProjectItem[]>
}): SwitcherCardDetails {
  const globalSDK = useGlobalSDK()
  const directory = input.meta?.directory
  const sessionId = input.meta?.type === "session" && input.meta.sessionId !== "new" ? input.meta.sessionId : undefined

  const vcs = useQuery(() => {
    const workspace = signedWorkspaceFromProjects(input.projects(), directory)
    return {
      ...workspaceVcsQuery({
        baseUrl: globalSDK.url,
        directory: directory ?? "",
        client: globalSDK.createClient({ directory, ...(workspace ? { workspaceId: workspace.workspaceId } : {}) }),
        workspaceId: workspace?.workspaceId,
        workspace,
        signedControlPlane: isRelayHostKind(workspace?.kind),
      }),
      enabled: !!directory,
    }
  })

  const [revision, setRevision] = createSignal(0)
  if (sessionId) onCleanup(subscribeSessionActivity(sessionId, () => setRevision((value) => value + 1)))
  const requests = () => {
    revision()
    return sessionId
      ? queryClient.getQueryData<SessionRequestsQueryData>(shellDataKeys.sessionId(sessionId, "requests"))
      : undefined
  }
  const todos = useQuery<Todo[]>(() => ({
    queryKey: shellDataKeys.sessionId(sessionId ?? "", "todo"),
    queryFn: skipToken,
    enabled: false,
  }))
  const diff = useQuery<SnapshotFileDiff[]>(() => ({
    queryKey: shellDataKeys.sessionId(sessionId ?? "", "diff"),
    queryFn: skipToken,
    enabled: false,
  }))

  const status = createMemo(() => sessionId
    ? switcherCardStatus({
      status: input.status(),
      turnStartedAt: () => registeredConversationLastUserMessageAt(directory ?? "", sessionId),
      waitingSince: () => requests()?.permissions?.[0]?.time?.created,
    })
    : undefined)

  return {
    status,
    question: () => (sessionId ? requests()?.questions?.[0]?.questions[0]?.question : undefined),
    todo: () => (sessionId ? switcherCardTodo(todos.data) : undefined),
    changes: () => (sessionId ? switcherCardChanges(diff.data) : undefined),
    gitBranch: () => vcs.data?.branch ?? undefined,
  }
}

// Measured when the row recomputes, not on a clock: a hover card is read in
// seconds, and ticking it would take a timer the strip does not otherwise run.
const since = (at: number | undefined) => (at ? formatCompactAge(at) : undefined)

export function switcherCardStatus(input: {
  status: SwitcherStatus | undefined
  turnStartedAt: () => number | undefined
  waitingSince: () => number | undefined
}): ReturnType<SwitcherCardDetails["status"]> {
  if (input.status === "working") {
    const age = since(input.turnStartedAt())
    return { text: age ? `Working for ${age}` : "Working" }
  }
  if (input.status === "permission") {
    const age = since(input.waitingSince())
    return { text: age ? `Waiting for you · ${age}` : "Waiting for you", tone: "attention" }
  }
  if (input.status === "error") return { text: "Last turn failed", tone: "attention" }
  return undefined
}

export function switcherCardTodo(list: readonly Todo[] | undefined): ReturnType<SwitcherCardDetails["todo"]> {
  if (!list?.length) return undefined
  return {
    text: list.find((todo) => todo.status === "in_progress")?.content,
    done: list.filter((todo) => todo.status === "completed").length,
    total: list.length,
  }
}

export function switcherCardChanges(files: readonly SnapshotFileDiff[] | undefined): ReturnType<SwitcherCardDetails["changes"]> {
  if (!files?.length) return undefined
  return {
    files: files.length,
    added: files.reduce((sum, file) => sum + file.additions, 0),
    removed: files.reduce((sum, file) => sum + file.deletions, 0),
  }
}

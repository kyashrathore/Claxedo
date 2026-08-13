/**
 * DirectoryScope
 *
 * Provides the full directory-level provider chain (SDK, Terminal, File, etc.)
 * accepting `directory` as a prop instead of reading from the URL via useParams().
 *
 * This enables multiple directory scopes to be mounted simultaneously in split mode,
 * each rendering their own session content with their own provider stack.
  *
  * The provider chain mirrors directory-layout.tsx but is decoupled from routing.
  */

import { Show, type Accessor, type ParentProps, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useWorkspaceQuery } from "../../../features/workspaces/data/use-workspace-query"
import { useSDK } from "@/app/providers/sdk/sdk"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { LocalProvider } from "@/features/session/providers/session-selection"
import { TerminalProvider } from "@/features/terminal/providers/provider"
import { FileProvider } from "@/app/providers/file"
import { PromptProvider } from "@/features/session/providers/prompt"
import { CommentScopeProvider, CommentsProvider } from "@/platform/comments/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { DataProvider } from "@/ui/session-kit-context"
import { SessionSyncProvider } from "@/features/session/providers/session-sync"
import { WorkspaceSDKProvider } from "./workspace-sdk-provider"
import { sessionRoute } from "@/platform/identity/route"
import { isDirectorylessPiSession, type SessionRef } from "@/platform/identity/session-ref"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { fetchSessionMessagesByTransport } from "../../../features/session/store/session-transport"
import { registeredConversationSnapshot } from "../../../features/session/conversation/conversation-registry"
import { hydrateConversationPage } from "../../../features/session/conversation/conversation-hydrator"
import { refreshDirectorySessionCache, type DirectorySessionCacheRefresh } from "../../../features/session/data/sync/directory-session-cache"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { agentListQuery } from "../../../features/session/data/query/directory"
import { directorySessionCacheQueryOptions, type DirectorySessionCacheValue } from "../../../features/session/data/sync/queries"
import {
  hydrateSubagentRows,
  presentSubagents,
  type HostSubagentRow,
} from "../../../features/session/subagents/subagent-presentation"
import { centralRuntimePath } from "@/platform/runtime/agent/central-runtime-path"

function DirectoryDataProvider(props: ParentProps<{
  data: DirectorySessionCacheValue
  directory: string
  sessionRef?: Accessor<SessionRef | undefined>
  harnessType?: Accessor<string | undefined>
  onNavigateToSession?: (sessionID: string) => void
  onSessionHref?: (sessionID: string) => string
  onSyncSession?: (sessionID: string) => void | Promise<void>
}>) {
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const subagents = globalSDK.event.subagents.registry
  const [subagentRevision, setSubagentRevision] = createSignal(0)
  const loadedSubagents = new Set<string>()
  const loadingSubagents = new Set<string>()
  onCleanup(subagents.subscribe((change) => {
    if (change.type === "reset") loadedSubagents.clear()
    if (change.type === "remove") loadedSubagents.delete(change.parentSessionId)
    setSubagentRevision((revision) => revision + 1)
  }))

  const ensureSubagents = (parentSessionId: string) => {
    if (loadedSubagents.has(parentSessionId) || loadingSubagents.has(parentSessionId)) return
    loadingSubagents.add(parentSessionId)
    const query = new URLSearchParams({ directory: props.directory })
    const path = centralRuntimePath(`/session/${encodeURIComponent(parentSessionId)}/subagents?${query}`, props.sessionRef?.())
    void sdk.request(path).then(async (response) => {
      if (!response.ok) throw new Error((await response.text()) || `Subagent read failed: ${response.status}`)
      hydrateSubagentRows(subagents, parentSessionId, await response.json() as HostSubagentRow[])
      loadedSubagents.add(parentSessionId)
    }).catch(() => {
      loadedSubagents.delete(parentSessionId)
    }).finally(() => {
      loadingSubagents.delete(parentSessionId)
    })
  }

  const resolveSubagents = (parentSessionId: string, toolCallId?: string) => {
    subagentRevision()
    ensureSubagents(parentSessionId)
    return presentSubagents(subagents, parentSessionId, toolCallId)
  }
  // agentListQuery hits the workspace RUNTIME for relay-backed scopes, so it must be structurally
  // disabled while that workspace is offline — otherwise it is the fire-and-fail
  // class (404/403 storm before `ready`). `useWorkspaceQuery` keys on the relay
  // workspaceId; for a local/central scope `workspace()` is undefined → the gate
  // is a no-op (always ready), preserving the loopback path verbatim.
  const agentQuery = useWorkspaceQuery(() => ({
    ...agentListQuery({
      baseUrl: sdk.url,
      directory: props.directory,
      harnessType: props.harnessType?.(),
      request: platform.fetch,
      workspace: sdk.workspace(props.directory),
      client: sdk.createClient({ directory: props.directory }),
    }),
    workspaceId: sdk.workspace(props.directory)?.workspaceId,
  }))
  const navigateToSession = (sessionID: string) => {
    props.onNavigateToSession?.(sessionID)
  }
  const sessionHref = props.onSessionHref
    ? (sessionID: string) => props.onSessionHref!(sessionID)
    : sessionRoute
  const syncSession = async (sessionID: string) => {
    if (props.onSyncSession) return await props.onSyncSession(sessionID)
    const snapshot = registeredConversationSnapshot(sessionID)
    if (snapshot.messages.length > 0) return
    const page = await fetchSessionMessagesByTransport({
      client: sdk.client.session,
      directory: props.directory,
      sessionID,
      limit: 80,
    })
    hydrateConversationPage({ sessionID, rows: page.data })
  }

  const sessionStatus = createMemo(() =>
    Object.fromEntries(
      props.data.session
        .map((session) => [
          session.id,
          untrack(() => queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId(session.id, "status"))),
        ] as const)
        .filter((entry): entry is readonly [string, SessionStatus] => !!entry[1]),
    ),
  )

  return (
    <DataProvider
      data={{ ...props.data, agent: agentQuery.data ?? [], session_status: sessionStatus(), session_diff: {}, message: {}, part: {} }}
      directory={props.directory}
      onNavigateToSession={navigateToSession}
      onSessionHref={sessionHref}
      resolveSubagents={resolveSubagents}
    >
      <SessionSyncProvider syncSession={syncSession}>
        {props.children}
      </SessionSyncProvider>
    </DataProvider>
  )
}

export function DirectoryScope(props: ParentProps<{
  directory: string
  sessionRef?: Accessor<SessionRef | undefined>
  workspaceId?: Accessor<string | undefined>
  workspaceKind?: Accessor<"cloud" | "user-hosted" | "local">
  harnessType?: Accessor<string | undefined>
  active?: Accessor<boolean>
  sessionId?: Accessor<string | undefined>
  surfaceId?: Accessor<string | undefined>
  workspaceReady: Accessor<boolean>
  refreshDirectory: DirectorySessionCacheRefresh
  onNavigateToSession?: (sessionID: string) => void
  onSessionHref?: (sessionID: string) => string
  onSyncSession?: (sessionID: string) => void | Promise<void>
}>) {
  const passiveHarnessType = () => {
    const type = props.harnessType?.()
    return type === "opencode" ? undefined : type
  }
  const dataProviderHarnessType = () => passiveHarnessType() ?? (runtimeRef() ? "opencode" : undefined)
  const active = () => props.active?.() ?? true
  const runtimeRef = () => {
    const ref = sessionWorkspaceRuntimeRef({ directory: props.directory, sessionRef: props.sessionRef?.() })
    if (ref) return ref
    const workspaceId = props.workspaceId?.()
    const kind = props.workspaceKind?.()
    if (!workspaceId || (kind !== "cloud" && kind !== "user-hosted")) return undefined
    return { workspaceId, kind }
  }
  // The session cache is a `skipToken` slot (populated by refreshDirectorySessionCache,
  // not auto-fetched) — but route it through the authority anyway so it is
  // STRUCTURALLY connection-aware: a relay-backed scope only reads cache once its
  // workspace is `ready`. For local scopes (`workspaceId` undefined) the gate is a
  // no-op, identical to today's behavior.
  const sessionCacheQuery = useWorkspaceQuery(() => ({
    ...directorySessionCacheQueryOptions({ directory: props.directory }),
    workspaceId: runtimeRef()?.workspaceId,
  }))
  const draftCacheData = createMemo<DirectorySessionCacheValue>(() => ({
    at: 0,
    limit: 0,
    total: 0,
    session: [],
  }))
  const draftSession = () => !props.sessionId?.() || props.sessionId?.() === "new"
  const canUseDraftCacheFallback = () => active() && draftSession()
  const canUseRouteSessionFallback = () => {
    const sessionId = props.sessionId?.()
    return active() && !!sessionId && sessionId !== "new" && (
      !!runtimeRef() || isDirectorylessPiSession({ directory: props.directory, sessionRef: props.sessionRef?.() })
    )
  }
  const data = () => props.workspaceReady()
    ? sessionCacheQuery.data ?? (canUseDraftCacheFallback() || canUseRouteSessionFallback() ? draftCacheData() : undefined)
    : undefined
  const loading = () => !data()

  // The refresh promise RESOLVES even when the underlying session load fails
  // (the error is toasted once upstream, then swallowed) — so "cache still
  // missing after the refresh settles" is the only failure signal available at
  // this layer. Track it and swap the spinner for a retryable error so the
  // pane cannot spin forever on a broken directory.
  const [bootstrapFailed, setBootstrapFailed] = createSignal(false)
  let warmSerial = 0
  const warm = (dir: string) => {
    const serial = ++warmSerial
    setBootstrapFailed(false)
    void refreshDirectorySessionCache({
      directory: dir,
      harnessType: untrack(passiveHarnessType),
      refresh: props.refreshDirectory,
    })
      .catch(() => undefined)
      .then(() => {
        if (serial !== warmSerial) return
        if (!sessionCacheQuery.data) setBootstrapFailed(true)
      })
  }
  const retryBootstrap = () => {
    if (props.directory) warm(props.directory)
  }

  // The connecting / provisioning / offline UI is owned by WorkspaceGate, which
  // wraps DirectoryScope and only renders it in its `ready` branch — by the time
  // this component mounts, the workspace runtime is guaranteed connected/healthy.
  // The only wait left here is the brief *data-cache* warm, so the fallback is a
  // lightweight spinner (NOT a second connection gate / CloudStartupView).
  const loadingFallback = () => (
    <div class="flex h-full w-full items-center justify-center bg-background-base text-text-weak">
      <Show
        when={!bootstrapFailed()}
        fallback={
          <div class="flex flex-col items-center gap-3 text-16-medium">
            <span>Failed to load sessions</span>
            <Button variant="secondary" onClick={retryBootstrap}>
              Retry
            </Button>
          </div>
        }
      >
        <div class="flex items-center gap-3 text-16-medium">
          <div class="size-5 animate-spin rounded-full border border-border-base border-t-transparent" />
          <span>Preparing workspace</span>
        </div>
      </Show>
    </div>
  )
  // Auto-bootstrap the workspace child for this directory. DirectoryScope
  // gates rendering on `status !== "loading"`, but no one triggers the
  // bootstrap automatically when a workbench tab mounts a session for a
  // never-seen directory after a hard reload — leaving the workbench-content
  // empty forever. This effect kicks bootstrap so the provider chain unblocks.
  createEffect(() => {
    const dir = props.directory
    if (!dir) return
    if (!active()) return
    if (!props.workspaceReady()) return
    if (sessionCacheQuery.data) return
    warm(dir)
  })
  return (
    <Show when={data() && !loading()} fallback={loadingFallback()}>
      <WorkspaceSDKProvider
        directory={() => props.directory}
        workspaceId={() => runtimeRef()?.workspaceId}
      >
        <DirectoryDataProvider
          data={data()!}
          directory={props.directory}
          sessionRef={props.sessionRef}
          harnessType={dataProviderHarnessType}
          onNavigateToSession={props.onNavigateToSession}
          onSessionHref={props.onSessionHref}
          onSyncSession={props.onSyncSession}
        >
          <TerminalProvider>
            <FileProvider>
              <PromptProvider directory={props.directory} sessionId={props.sessionId} draftId={props.surfaceId}>
                <CommentScopeProvider
                  directory={() => props.directory}
                  sessionId={() => props.sessionId?.()}
                >
                  <CommentsProvider>
                    <LocalProvider sessionId={props.sessionId} sessionRef={props.sessionRef}>
                      {props.children}
                    </LocalProvider>
                  </CommentsProvider>
                </CommentScopeProvider>
              </PromptProvider>
            </FileProvider>
          </TerminalProvider>
        </DirectoryDataProvider>
      </WorkspaceSDKProvider>
    </Show>
  )
}

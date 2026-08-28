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
import { WorkspaceVcsCacheHonesty } from "./workspace-vcs-cache-honesty"
import { PromptProvider } from "@/features/session/providers/prompt"
import { CommentScopeProvider, CommentsProvider } from "@/platform/comments/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { DataProvider } from "@/ui/session-kit-context"
import { SessionSyncProvider } from "@/features/session/providers/session-sync"
import { WorkspaceSDKProvider } from "./workspace-sdk-provider"
import { sessionRoute } from "@/platform/identity/route"
import type { SessionRef } from "@/platform/identity/session-ref"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import {
  refreshDirectorySessionCache,
  sessionLoadMetaKey,
  sessionLoadMetaMatchesWorkspace,
  type DirectorySessionCacheRefresh,
  type DirectorySessionLoadMeta,
} from "../../../features/session/data/sync/directory-session-cache"
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
import {
  createDeferredDirectoryResourceGate,
  DIRECTORY_RESOURCE_FIRST_PAINT_DELAY_MS,
} from "@/features/session/data/query/deferred-directory-resource"
import { fastSessionSwitchQuietDelay } from "@/platform/runtime/session-switch"

function DirectoryDataProvider(props: ParentProps<{
  data: DirectorySessionCacheValue
  directory: string
  active: Accessor<boolean>
  sessionId?: Accessor<string | undefined>
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
  const [subagentHydrationRevision, setSubagentHydrationRevision] = createSignal(0)
  let subagentsDirtyWhileInactive = false
  const publishSubagentChange = () => {
    if (!props.active()) {
      subagentsDirtyWhileInactive = true
      return
    }
    subagentsDirtyWhileInactive = false
    setSubagentRevision((revision) => revision + 1)
  }
  onCleanup(subagents.subscribe((change) => {
    if (change.type !== "reset" && change.parentSessionId !== props.sessionId?.()) return
    if (change.type === "reset") setSubagentHydrationRevision((revision) => revision + 1)
    publishSubagentChange()
  }))
  createEffect(() => {
    if (!props.active() || !subagentsDirtyWhileInactive) return
    publishSubagentChange()
  })

  const ensureSubagents = (parentSessionId: string, callerSignal: AbortSignal) => {
    const query = new URLSearchParams({ directory: props.directory })
    const path = centralRuntimePath(`/session/${encodeURIComponent(parentSessionId)}/subagents?${query}`, props.sessionRef?.())
    return subagents.ensureHydrated(
      parentSessionId,
      async (signal) => {
        const response = await sdk.request(path, { signal })
        if (!response.ok) throw new Error((await response.text()) || `Subagent read failed: ${response.status}`)
        return await response.json() as HostSubagentRow[]
      },
      (rows, active) => hydrateSubagentRows(subagents, parentSessionId, rows, active),
      { signal: callerSignal },
    )
  }

  const resolveSubagents = (parentSessionId: string, toolCallId?: string) => {
    subagentRevision()
    return presentSubagents(subagents, parentSessionId, toolCallId)
  }
  // agentListQuery hits the workspace RUNTIME for relay-backed scopes, so it must be structurally
  // disabled while that workspace is offline — otherwise it is the fire-and-fail
  // class (404/403 storm before `ready`). `useWorkspaceQuery` keys on the relay
  // workspaceId; for a local/central scope `workspace()` is undefined → the gate
  // is a no-op (always ready), preserving the loopback path verbatim.
  const hydrateDirectoryAgents = createDeferredDirectoryResourceGate({
    scope: () => `${sdk.url ?? ""}:${props.directory}:${props.harnessType?.() ?? ""}`,
    active: props.active,
  })
  const hydrateSessionSubagents = createDeferredDirectoryResourceGate({
    scope: () => {
      const sessionID = props.sessionId?.()
      return sessionID ? `${sdk.url ?? ""}:${props.directory}:${sessionID}` : undefined
    },
    active: props.active,
    delayMs: () => fastSessionSwitchQuietDelay({
      sessionId: props.sessionId?.(),
      baseDelay: DIRECTORY_RESOURCE_FIRST_PAINT_DELAY_MS,
    }),
    afterPaint: false,
  })
  createEffect(() => {
    if (!hydrateSessionSubagents()) return
    const sessionID = props.sessionId?.()
    if (!sessionID) return
    subagentHydrationRevision()
    const controller = new AbortController()
    void ensureSubagents(sessionID, controller.signal).catch(() => undefined)
    onCleanup(() => controller.abort())
  })
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
    enabled: hydrateDirectoryAgents(),
  }))
  const navigateToSession = (sessionID: string) => {
    props.onNavigateToSession?.(sessionID)
  }
  const sessionHref = props.onSessionHref
    ? (sessionID: string) => props.onSessionHref!(sessionID)
    : sessionRoute
  const syncSession = async (sessionID: string) => {
    if (props.onSyncSession) return await props.onSyncSession(sessionID)
  }

  const sessionStatus = createMemo(() =>
    Object.fromEntries(
      props.data.session
        .map((session) => [
          session.id,
          queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId(session.id, "status")),
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
      <LocalProvider
        sessionId={props.sessionId}
        sessionRef={props.sessionRef}
        active={props.active}
        agents={() => agentQuery.data ?? []}
      >
        <SessionSyncProvider syncSession={syncSession}>
          {props.children}
        </SessionSyncProvider>
      </LocalProvider>
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
  const passiveHarnessType = createMemo(() => {
    const type = props.harnessType?.()
    return type === "opencode" ? undefined : type
  })
  const active = createMemo(() => props.active?.() ?? true)
  // Runtime identity is consumed by query gating, cache authority checks and
  // the data provider. Resolve it once per actual identity change; plain
  // accessors previously repeated signed/legacy workspace parsing at every
  // consumer read.
  const runtimeRef = createMemo(() => {
    const workspaceId = props.workspaceId?.()
    const kind = props.workspaceKind?.()
    if (workspaceId && (kind === "cloud" || kind === "user-hosted")) return { workspaceId, kind }
    return sessionWorkspaceRuntimeRef({ directory: props.directory, sessionRef: props.sessionRef?.() })
  })
  const dataProviderHarnessType = createMemo(() => passiveHarnessType() ?? (runtimeRef() ? "opencode" : undefined))
  // The session cache is a `skipToken` slot (populated by refreshDirectorySessionCache,
  // not auto-fetched) — but route it through the authority anyway so it is
  // STRUCTURALLY connection-aware: a relay-backed scope only reads cache once its
  // workspace is `ready`. For local scopes (`workspaceId` undefined) the gate is a
  // no-op, identical to today's behavior.
  const sessionCacheQuery = useWorkspaceQuery(() => ({
    ...directorySessionCacheQueryOptions({ directory: props.directory }),
    workspaceId: runtimeRef()?.workspaceId,
  }))
  const cacheMatchesAuthority = () => sessionLoadMetaMatchesWorkspace(
    queryClient.getQueryData<DirectorySessionLoadMeta>(sessionLoadMetaKey(props.directory)),
    runtimeRef(),
  )
  const authoritativeCacheData = () => cacheMatchesAuthority() ? sessionCacheQuery.data : undefined
  const draftCacheData = createMemo<DirectorySessionCacheValue>(() => ({
    at: 0,
    limit: 0,
    total: 0,
    session: [],
  }))
  const draftSession = () => !props.sessionId?.() || props.sessionId?.() === "new"
  const canUseDraftCacheFallback = () => active() && draftSession()
  // Any routed, already-created session can mount on the empty fallback cache:
  // the session content loads its own messages, and the cache rows arrive when
  // the warm settles. Gating LOCAL scopes out of this fallback left them on the
  // spinner until the warm resolved — and on the retryable error screen when it
  // failed — for content that never needed the cache to render.
  const canUseRouteSessionFallback = () => {
    const sessionId = props.sessionId?.()
    return active() && !!sessionId && sessionId !== "new"
  }
  const data = () => props.workspaceReady()
    ? authoritativeCacheData() ?? (canUseDraftCacheFallback() || canUseRouteSessionFallback() ? draftCacheData() : undefined)
    : undefined
  const loading = () => !data()

  // The refresh promise RESOLVES even when the underlying session load fails
  // (the error is toasted once upstream, then swallowed) — so "cache still
  // missing after the refresh settles" is the only failure signal available at
  // this layer. Track it and swap the spinner for a retryable error so the
  // pane cannot spin forever on a broken directory.
  const [bootstrapFailed, setBootstrapFailed] = createSignal(false)
  let warmSerial = 0
  const warm = (dir: string, workspace = runtimeRef()) => {
    const serial = ++warmSerial
    setBootstrapFailed(false)
    void refreshDirectorySessionCache({
      directory: dir,
      harnessType: untrack(passiveHarnessType),
      refresh: props.refreshDirectory,
      ...(workspace ? { workspace } : {}),
    })
      .catch(() => undefined)
      .then(() => {
        if (serial !== warmSerial) return
        if (!authoritativeCacheData()) setBootstrapFailed(true)
      })
  }
  const retryBootstrap = () => {
    if (props.directory) warm(props.directory, runtimeRef())
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
    if (authoritativeCacheData()) return
    warm(dir, runtimeRef())
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
          active={active}
          sessionId={props.sessionId}
          sessionRef={props.sessionRef}
          harnessType={dataProviderHarnessType}
          onNavigateToSession={props.onNavigateToSession}
          onSessionHref={props.onSessionHref}
          onSyncSession={props.onSyncSession}
        >
          <TerminalProvider>
            <WorkspaceVcsCacheHonesty directory={props.directory} />
            <FileProvider>
              <PromptProvider directory={props.directory} sessionId={props.sessionId} draftId={props.surfaceId}>
                <CommentScopeProvider
                  directory={() => props.directory}
                  sessionId={() => props.sessionId?.()}
                >
                  <CommentsProvider>{props.children}</CommentsProvider>
                </CommentScopeProvider>
              </PromptProvider>
            </FileProvider>
          </TerminalProvider>
        </DirectoryDataProvider>
      </WorkspaceSDKProvider>
    </Show>
  )
}

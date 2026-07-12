import type { CloudLog } from "@/features/session/ui/components/cloud-startup-view"
import { appendWorkspaceRuntimeLog } from "@/platform/runtime/cloud/workspace-runtime-store"
import type { useClaxedoState } from "@/features/session/app-ports"
import { scheduleSessionProjectionPull } from "@/platform/runtime/agent/session-projection"
import type {
  HarnessConfigPromoter,
  ClaxedoLifecycleListener,
  SubmitDirectory,
  SubmitSessionGetClient,
  SubmitSessionTarget,
  SubmitSessionTargetResult,
} from "../../submit/index"
import { applyCreatedSessionTargetEffects, createOpencodeSessionWithLifecycle, resolveSubmitSessionTarget } from "../../submit/index"
import type { HarnessRef, SessionRef } from "@/platform/identity/session-ref"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import {
  sessionRefForSubmitTarget,
  type ProjectCatalogItem,
  type RuntimeWorkspaceRef,
} from "../workspace-resolver"

export type SubmitProjectionScheduler = typeof scheduleSessionProjectionPull

export type SubmitSessionCreateClient = {
  readonly session: SubmitSessionGetClient["session"] & {
    create(
      input: { readonly directory: SubmitDirectory },
      init?: { readonly headers?: Record<string, string> },
    ): Promise<{ readonly data?: SubmitSessionTarget }>
  }
}

export type SubmitSessionTargetAcquisitionInput = {
  readonly session: SubmitSessionTarget | undefined
  readonly explicitSessionID: string | undefined
  readonly isNewSession: boolean
  readonly replaceSession: boolean
  readonly harnessMode: boolean
  readonly signedControlPlane: boolean
  readonly sessionDirectory: SubmitDirectory
  readonly client: SubmitSessionGetClient
  readonly sessionClient: () => SubmitSessionGetClient
  readonly scope: string
  readonly draftId: string | undefined
  readonly sessionHarnessType: string
  readonly events: ClaxedoLifecycleListener | undefined
  readonly boot: (sessionID?: string) => void
  readonly createSessionClient: (input: {
    readonly directory: SubmitDirectory
    readonly harnessType: string
  }) => SubmitSessionCreateClient
  readonly claimHarnessSession: (input: {
    readonly scope: string
    readonly directory: SubmitDirectory
    readonly sessionID: string | undefined
  }) => Promise<SubmitSessionTarget | undefined>
  readonly onOpencodeCreateError: (err: unknown) => void
}

export type CloudStartupState = {
  open: boolean
  sync?: boolean
  id?: string
  status?: string
  err?: string
  logs?: CloudLog[]
}

export function createCloudStartupController(input: {
  readonly enabled: boolean
  readonly onCloudStartup?: (state?: CloudStartupState) => void
  readonly errorMessage: (err: unknown) => string
  readonly now?: () => number
}) {
  let lastState: Omit<CloudStartupState, "open"> | undefined
  const now = () => input.now?.() ?? Date.now()
  const publishState = () => {
    input.onCloudStartup?.({
      open: true,
      ...lastState,
    })
  }

  return {
    remember(state: Omit<CloudStartupState, "open">) {
      lastState = state
    },
    publish(status: string, message: string) {
      if (!input.enabled) return
      lastState = {
        id: lastState?.id,
        status,
        err: undefined,
        logs: appendWorkspaceRuntimeLog(lastState?.logs ?? [], status, message, undefined, now()),
      }
      publishState()
    },
    clear() {
      if (input.enabled) input.onCloudStartup?.()
      lastState = undefined
    },
    reportError(err: unknown) {
      if (!input.enabled) return
      const message = input.errorMessage(err)
      lastState = {
        id: lastState?.id,
        status: "error",
        err: message,
        logs: appendWorkspaceRuntimeLog(lastState?.logs ?? [], "error", message, undefined, now()),
      }
      publishState()
    },
  }
}

export async function acquireSubmitSessionTarget(
  input: SubmitSessionTargetAcquisitionInput,
): Promise<SubmitSessionTargetResult> {
  return await resolveSubmitSessionTarget({
    isNewSession: input.isNewSession,
    replaceSession: input.replaceSession,
    harnessMode: input.harnessMode,
    signedControlPlane: input.signedControlPlane,
    sessionDirectory: input.sessionDirectory,
    client: input.client,
    sessionClient: input.sessionClient,
    createSessionTarget: () => createRuntimeSessionTarget(input),
    ...(input.session === undefined ? {} : { session: input.session }),
    ...(input.explicitSessionID === undefined ? {} : { explicitSessionID: input.explicitSessionID }),
  })
}

async function createRuntimeSessionTarget(input: SubmitSessionTargetAcquisitionInput) {
  if (input.harnessMode) {
    const session = await input.claimHarnessSession({
      scope: input.scope,
      directory: input.sessionDirectory,
      sessionID: input.explicitSessionID,
    }).catch(() => undefined)
    if (session) input.boot(session.id)
    return session
  }

  return await createOpencodeSession(input).catch((err) => {
    input.onOpencodeCreateError(err)
    return undefined
  })
}

async function createOpencodeSession(input: SubmitSessionTargetAcquisitionInput) {
  const headers: Record<string, string> = {}
  if (input.draftId) headers["x-claxedo-draft-id"] = input.draftId
  const client = input.createSessionClient({
    directory: input.sessionDirectory,
    harnessType: input.sessionHarnessType,
  })
  return await createOpencodeSessionWithLifecycle({
    perform: async () => {
      const res = await client.session.create(
        { directory: input.sessionDirectory },
        Object.keys(headers).length > 0 ? { headers } : undefined,
      )
      if (!res.data?.id) throw new Error("Failed to create session")
      return res.data
    },
    ...(input.draftId === undefined ? {} : { draftId: input.draftId }),
    ...(input.events === undefined ? {} : { events: input.events }),
  })
}

export function finalizeSubmitSessionTarget(input: {
  readonly target: { readonly created: boolean }
  readonly session: SubmitSessionTarget
  readonly sessionDirectory: SubmitDirectory
  readonly scope: string
  readonly surfaceId: string | undefined
  readonly claxedoState: ReturnType<typeof useClaxedoState> | undefined
  readonly projects: readonly ProjectCatalogItem[]
  readonly runtimeWorkspaceRef: RuntimeWorkspaceRef | undefined
  readonly harness: HarnessRef | undefined
  readonly agent: string
  readonly model: { providerID: string; modelID: string }
  readonly variant: string | undefined
  readonly draftId: string | undefined
  readonly previousSessionId: string
  readonly shouldAutoAccept: boolean
  readonly harnessConfig: HarnessConfigPromoter | undefined
  readonly enableAutoAccept: (sessionID: string, directory: SubmitDirectory) => void
  readonly navigateOnCreate: boolean
  readonly setLayoutTabs: (sessionKey: string, sessionID: string) => void
  readonly navigate: (href: string) => void
  readonly publishCloudHandoff: (status: string, message: string) => void
  readonly scheduleProjectionPull?: SubmitProjectionScheduler
  readonly promoteSession: (
    directory: SubmitDirectory,
    sessionID: string,
    config: { harness?: HarnessRef; agent: string; model: { providerID: string; modelID: string }; variant: string | null },
  ) => void
}) {
  const sessionRef = sessionRefForSurface({
    created: input.target.created,
    session: input.session,
    sessionDirectory: input.sessionDirectory,
    surfaceId: input.surfaceId,
    claxedoState: input.claxedoState,
    projects: input.projects,
    runtimeWorkspaceRef: input.runtimeWorkspaceRef,
    harness: input.harness,
  })

  if (input.target.created) {
    input.promoteSession(input.sessionDirectory, input.session.id, {
      ...(input.harness ? { harness: input.harness } : {}),
      agent: input.agent,
      model: input.model,
      variant: input.variant ?? null,
    })
    const runtimeRef = sessionWorkspaceRuntimeRef({
      directory: input.sessionDirectory,
      ...(sessionRef === undefined ? {} : { sessionRef }),
    })
    void (input.scheduleProjectionPull ?? scheduleSessionProjectionPull)({
      action: "register",
      reason: "session-created",
      workspaceId: runtimeRef?.workspaceId,
      sessionId: input.session.id,
      idempotencyKey: `session-created:${runtimeRef?.workspaceId ?? ""}:${input.session.id}:${input.draftId ?? ""}`,
    })
  }

  return {
    sessionRef,
    handoffCreatedSession: applyCreatedSessionTargetEffects({
      created: input.target.created,
      session: input.session,
      sourceScope: input.scope,
      sessionDirectory: input.sessionDirectory,
      shouldAutoAccept: input.shouldAutoAccept,
      enableAutoAccept: input.enableAutoAccept,
      navigateOnCreate: input.navigateOnCreate,
      previousSessionId: input.previousSessionId,
      setLayoutTabs: input.setLayoutTabs,
      navigate: input.navigate,
      publishCloudHandoff: input.publishCloudHandoff,
      ...(input.harnessConfig === undefined ? {} : { harnessConfig: input.harnessConfig }),
      ...(sessionRef === undefined ? {} : { sessionRef }),
      ...(input.surfaceId === undefined ? {} : { surfaceId: input.surfaceId }),
      ...(input.draftId === undefined ? {} : { draftId: input.draftId }),
      ...(input.claxedoState === undefined ? {} : { claxedoState: input.claxedoState }),
    }).handoffCreatedSession,
  }
}

export function patchExistingSubmitSessionRef(input: {
  readonly claxedoState: ReturnType<typeof useClaxedoState> | undefined
  readonly surfaceId: string | undefined
  readonly sessionID: string
  readonly sessionRef: SessionRef
}) {
  const meta = input.surfaceId
    ? input.claxedoState?.meta.get(input.surfaceId)
    : input.claxedoState?.meta.find((item) => item.sessionId === input.sessionID)
  if (meta?.content?.type !== "session") return
  input.claxedoState?.meta.patch(meta.id, {
    content: {
      ...meta.content,
      type: "session",
      sessionRef: input.sessionRef,
    },
  })
}

function sessionRefForSurface(input: {
  readonly created: boolean
  readonly session: SubmitSessionTarget
  readonly sessionDirectory: SubmitDirectory
  readonly surfaceId: string | undefined
  readonly claxedoState: ReturnType<typeof useClaxedoState> | undefined
  readonly projects: readonly ProjectCatalogItem[]
  readonly runtimeWorkspaceRef: RuntimeWorkspaceRef | undefined
  readonly harness: HarnessRef | undefined
}): SessionRef | undefined {
  const resolved = () => sessionRefForSubmitTarget({
    sessionId: input.session.id,
    directory: input.sessionDirectory,
    projects: input.projects,
    ...(input.runtimeWorkspaceRef === undefined ? {} : { runtimeWorkspaceRef: input.runtimeWorkspaceRef }),
    ...(input.harness === undefined ? {} : { harness: input.harness }),
  })
  if (input.created) return resolved()

  const withHarness = (ref: SessionRef | undefined) =>
    ref && input.harness ? { ...ref, harness: input.harness } : ref
  const surfaceMeta = input.surfaceId ? input.claxedoState?.meta.get(input.surfaceId) : undefined
  return withHarness(surfaceMeta?.content?.sessionRef) ??
    withHarness(input.claxedoState?.meta.find((meta) => meta.sessionId === input.session.id)?.content?.sessionRef) ??
    resolved()
}

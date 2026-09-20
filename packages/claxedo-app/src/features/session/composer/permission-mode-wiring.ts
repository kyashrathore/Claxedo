import { asRecord, readString } from "@/lib/record"
import { createResource, createSignal, onCleanup, type Accessor } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import {
  fetchSessionPermissionModesByTransport,
  setSessionPermissionModeByTransport,
} from "@/features/session/store/session-transport"
import type { AgentRuntimeDirectory } from "@/platform/runtime/agent/agent-runtime-client"
import { applyPermissionMode } from "@/features/session/permission/apply"
import { createComposerAutoAccept } from "./auto-accept"
import { createComposerPermissionMode } from "./permission-mode"
import type { HarnessId } from "@/platform/identity/session-ref"
import { isHarnessSelection, type HarnessSelection } from "@/platform/identity/harness-selection"
import {
  type HarnessModeReport,
  type PermissionSelection,
} from "@/features/session/permission/modes"
import type { SessionPermissionWriter } from "@/features/session/permission/apply"
import type { SessionRef, WorkspaceSessionBacking } from "@/platform/identity/session-ref"
import { fastSessionSwitchQuietDelay } from "@/platform/runtime/session-switch"

/**
 * The I/O half of the composer's permission-mode picker: fetching what the
 * harness offers, writing a choice back, and reconciling the two.
 *
 * Split out of `composer.tsx` because that file is at the architecture guard's
 * 800-line hard cap, which cannot be allowlisted. The seam is a real one rather
 * than a size dodge — everything here is transport and reconciliation, while
 * `createComposerPermissionMode` next door is pure derivation over what this
 * returns and is tested without any of it.
 */
export function createComposerPermissionModeWiring(input: {
  sessionId: () => string | undefined
  directory: () => AgentRuntimeDirectory
  /**
   * The harness the composer currently targets. Part of the resource KEY, not
   * just context: switching harness must invalidate the previous answer, or the
   * picker keeps showing the old harness's modes until a slower fetch lands —
   * which reads as the switch not having worked.
   */
  harness: () => string | undefined
  harnessSelection?: () => HarnessSelection | undefined
  /**
   * Why this harness cannot report, when it cannot.
   *
   * The draft list is a RECORDED table, not something the agent said — so it
   * answers just as confidently for a harness that failed to start as for one
   * that is running. That produced a picker offering "Codex (ACP) · Agent" one
   * line under "Codex could not start", which is worse than showing nothing:
   * the modes look like the agent's own report, and choosing one appears to set
   * a policy that can never be applied because there is no agent to apply it to.
   */
  harnessUnavailable?: () => string | undefined
  claxedoServerUrl: () => string
  signedControlPlane: () => boolean
  workspace: () => WorkspaceSessionBacking | undefined
  sessionRef: () => SessionRef | undefined
  requestFailedTitle: () => string
}) {
  /**
   * The session ref travels on every path, local included: a draft has no
   * session id for the runtime to resolve an adapter from, so the ref's tool
   * sandbox is the only thing that places `GET /permission/modes` on the
   * loopback runtime. Workspace scope is added only where a workspace exists.
   */
  const transportScope = () => {
    const workspace = input.workspace()
    return {
      claxedoServerUrl: input.claxedoServerUrl(),
      signedControlPlane: input.signedControlPlane(),
      ...(workspace ? { workspaceId: workspace.workspaceId, hostKind: workspace.kind } : {}),
      sessionRef: input.sessionRef(),
    }
  }
  /**
   * Two-argument `createResource` on purpose: the one-argument form runs once
   * and then never re-runs when the session id arrives, which is the
   * kept-mounted-dialog trap this codebase has hit before. A draft becoming a
   * session must re-fetch, because the harness can only report its live state
   * once there is a session.
   */
  const resourceKey = () => JSON.stringify({
    sessionID: input.sessionId() ?? "",
    directory: input.directory(),
    harness: input.harness() ?? null,
    selection: input.harnessSelection?.() ?? input.sessionRef()?.harness ?? null,
  })
  const answered = (unsupported: string): HarnessModeReport => ({
    modes: [],
    unsupported,
    appliesFrom: "next-turn",
  })
  let cancelQuietWait: (() => void) | undefined
  const waitForQuietWindow = (delay: number) => {
    cancelQuietWait?.()
    if (delay <= 0) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (ready: boolean) => {
        if (settled) return
        settled = true
        if (cancelQuietWait === cancel) cancelQuietWait = undefined
        resolve(ready)
      }
      const timer = setTimeout(() => finish(true), delay)
      const cancel = () => {
        clearTimeout(timer)
        finish(false)
      }
      cancelQuietWait = cancel
    })
  }
  onCleanup(() => cancelQuietWait?.())
  const [resource, { refetch }] = createResource(
    // A DRAFT still fetches, with an empty session id, so the
    // picker can show the harness's real modes before the first message rather
    // than a placeholder — the opening turn is when the choice matters most.
    //
    // The source is a serialized string, not an object literal, deliberately:
    // createResource compares sources with `===`, so a fresh object would
    // refetch on every upstream signal wobble even when the resolved values
    // are identical. Serializing keeps the refetch keyed to the
    // session/directory/harness actually changing (or an explicit
    // `refetch()`) while dropping the byte-identical repeats. The request
    // itself stays `no-store` — nothing here caches a response.
    resourceKey,
    async (sourceKey) => {
      // `sourceKey` is this module's own `JSON.stringify`, but it comes back as
      // JSON — read the three fields rather than asserting the shape back.
      const parsed = asRecord(JSON.parse(sourceKey))
      const selection = parsed ? parsed.selection : undefined
      const source = {
        sessionID: readString(parsed, "sessionID") ?? "",
        directory: readString(parsed, "directory") ?? "",
        selection: isHarnessSelection(selection) ? selection : null,
      }
      if (!source.sessionID && !source.selection) return undefined
      // Every new source/refetch cancels the previous wait. Owner cleanup also
      // resolves it false, so disposed surfaces never escape into transport I/O.
      const delay = fastSessionSwitchQuietDelay({ sessionId: source.sessionID })
      if (!await waitForQuietWindow(delay)) return undefined
      return (
        await fetchSessionPermissionModesByTransport({
          ...transportScope(),
          directory: source.directory,
          sessionID: source.sessionID,
          ...(source.selection ? { harness: source.selection } : {}),
        })
      ).data
    },
  )

  /**
   * Four states, not two, and the two extra ones are the whole point.
   *
   * `undefined` from here means "in flight", and the picker renders that as
   * loading copy. So every state that is not in flight has to be turned into a
   * real answer, or it renders as a spinner that never resolves.
   *
   * A failed fetch leaves `latest` undefined, so without this branch a dead
   * backend is indistinguishable from a slow one and renders as a spinner that
   * never resolves — the same defect as the "Waiting for … to report its modes"
   * bug this whole feature replaced, one layer higher.
   *
   * `latest` is used for the success path so a refetch does not blank a
   * still-true answer.
   */
  /**
   * Cache keyed by harness, so switching back and forth is instant instead of
   * re-fetching a list that cannot have changed. Stale-while-revalidate: the
   * cached answer shows immediately and the live fetch replaces it.
   */
  const cache = new Map<string, HarnessModeReport>()

  const report = (): HarnessModeReport | undefined => {
    // Checked before the fetch result, because the fetch succeeds either way.
    // The directory-scoped route answers from the recorded table without ever
    // asking the agent, so a broken harness still returns a full, plausible
    // list — and a list is the one thing that must not be shown here.
    const unavailable = input.harnessUnavailable?.()
    if (unavailable) return answered(unavailable)
    if (resource.error) {
      const detail = resource.error instanceof Error ? resource.error.message : String(resource.error)
      return answered(`Could not load permission modes: ${detail}`)
    }
    const live = resource.state === "ready" ? resource() : undefined
    const key = input.harness() ?? ""
    if (live) {
      cache.set(key, live)
      return live
    }
    // In flight: show this harness's cached answer if we have one, and undefined
    // otherwise. Deliberately not `resource.latest` — that keeps the previous
    // harness's list on screen across a switch, which is the stale-read the
    // harness key exists to prevent.
    return cache.get(key)
  }

  /**
   * Optimistic value covering the gap between choosing a harness mode and the
   * refetch that confirms it.
   *
   * Needed because the harness — not Claxedo — is the store for these modes, so
   * without it the row would visibly snap back to the old value until the fetch
   * returned. Cleared on BOTH outcomes: on success the refetch supersedes it, and
   * on failure it must go or the picker keeps asserting a mode the harness
   * refused.
   */
  const [pending, setPending] = createSignal<PermissionSelection | undefined>()

  const writer = (): SessionPermissionWriter => ({
    setPermissionMode: async (call) => {
      const result = await setSessionPermissionModeByTransport({
        ...transportScope(),
        directory: input.directory(),
        sessionID: call.sessionID,
        modeId: call.modeId,
      })
      void refetch()
      setPending(undefined)
      // The harness's answer, which can name a different mode than the request.
      return { currentModeId: result.data?.currentModeId }
    },
  })

  const reportError = (error: unknown) => {
    setPending(undefined)
    const detail = error instanceof Error ? error.message : String(error)
    showToast({
      variant: "error",
      title: input.requestFailedTitle(),
      // Says the change did not happen. Silence here would leave the user
      // believing a policy is in force that the harness never accepted.
      description: `The permission mode was not changed: ${detail}`,
    })
  }

  // The harness owns the active mode. Pending only bridges an in-flight write.
  const selection = (): PermissionSelection | undefined => input.harness() ? pending() : undefined
  const onSelectionChange = (next: PermissionSelection) => {
    if (next.kind === "harness") setPending(next)
  }

  return { report, pending, setPending, writer, reportError, selection, onSelectionChange,
    /** Re-exported so the picker's groups can suppress every option, not just the list. */
    harnessUnavailable: () => input.harnessUnavailable?.() }
}

/**
 * The composer's whole permission surface composed in one place: transport
 * wiring, the auto-accept switch, and the mode picker derived from both.
 * Lives here for the same reason the wiring does — `composer.tsx` sits at the
 * 800-line hard cap, and this composition is policy over this module's seam.
 */
export function createComposerPermissionSurface(input: {
  sessionId: () => string | undefined
  resolvedSessionId: () => string | undefined
  directory: () => AgentRuntimeDirectory
  harness: Accessor<HarnessId | undefined>
  harnessSelection?: Accessor<HarnessSelection | undefined>
  harnessUnavailable: () => string | undefined
  claxedoServerUrl: () => string
  signedControlPlane: () => boolean
  workspace: () => WorkspaceSessionBacking | undefined
  sessionRef: () => SessionRef | undefined
  requestFailedTitle: () => string
  permission: Parameters<typeof createComposerAutoAccept>[0]["permission"]
}) {
  const permissionModeWiring = createComposerPermissionModeWiring({
    sessionId: input.sessionId,
    directory: input.directory,
    harness: input.harness,
    harnessSelection: input.harnessSelection,
    harnessUnavailable: input.harnessUnavailable,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspace: input.workspace,
    sessionRef: input.sessionRef,
    requestFailedTitle: input.requestFailedTitle,
  })

  const autoAccept = createComposerAutoAccept({
    permission: input.permission,
    sessionId: input.sessionId,
    directory: input.directory,
  })
  const permissionMode = createComposerPermissionMode({
    harness: input.harness,
    report: permissionModeWiring.report,
    unavailable: permissionModeWiring.harnessUnavailable,
    selection: permissionModeWiring.selection,
    onSelectionChange: permissionModeWiring.onSelectionChange,
    deliver: async ({ option, sessionID }) =>
      applyPermissionMode({ delivery: option.delivery, sessionID, client: permissionModeWiring.writer() }),
    // Drops the optimistic value as well as toasting — see `reportError`.
    onDeliveryError: ({ error }) => permissionModeWiring.reportError(error),
    sessionId: input.resolvedSessionId,
  })

  return { permissionModeWiring, autoAccept, permissionMode }
}

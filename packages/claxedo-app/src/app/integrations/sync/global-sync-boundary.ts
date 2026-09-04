import { createComputed, onCleanup, onMount, type Accessor } from "solid-js"
import { useGlobalSync } from "@/app/providers/global-sync/provider"
import { clearRegisteredConversationMemory } from "@/features/session/conversation/conversation-registry"
import { setConversationPersistencePrincipal } from "@/features/session/conversation/conversation-persistence"
import { principalDataScope, type Principal } from "@/platform/auth/identity-provider"
import { queryClient } from "@/platform/query/query-client"
import type {
  SessionAccessRevocationSource,
  SessionAccessRevokedEvent,
} from "@/app/integrations/session-events/event-ingress"

export type GlobalReadinessSource = {
  ready: boolean
}

export function globalShellReady(input: { source: GlobalReadinessSource }) {
  return input.source.ready
}

export function useGlobalShellReady() {
  const source = useGlobalSync()
  return () => globalShellReady({ source })
}

function useSessionAccessRevocations(
  source: SessionAccessRevocationSource,
  listener: (event: SessionAccessRevokedEvent) => void,
) {
  onMount(() => onCleanup(source.onSessionAccessRevoked(listener)))
}

/** Shell boundary adapter for access-loss events published by GlobalSync. */
export function useGlobalSessionAccessRevocations(
  listener: (event: SessionAccessRevokedEvent) => void,
) {
  useSessionAccessRevocations(useGlobalSync(), listener)
}

/**
 * App-owned principal transition boundary.
 *
 * Every query can carry identity-derived data, including families introduced
 * outside the session feature. Clearing the whole client keeps that invariant
 * closed under future additions; conversation memory is the only authority
 * state outside TanStack Query and is cleared through its narrow owner API.
 */
export function clearPrincipalData() {
  clearRegisteredConversationMemory()
  // `clear()` destroys queries outright, and destroying one whose fetch is
  // still in flight rejects that fetch with a CancelledError nothing awaits —
  // an unhandledrejection overlay on every sign-in/out with a fetch open.
  // `cancelQueries()` marks every in-flight retryer cancelled synchronously
  // and OBSERVES the rejections; the clear on the same tick then destroys
  // already-settled queries, so the isolation timing is unchanged.
  queryClient.cancelQueries().catch(() => undefined)
  queryClient.clear()
}

/**
 * The one transition that is not a change of person: the desktop boots as the
 * local device and becomes the signed user a few seconds later, once main has
 * restored the credential. Everything cached until then is this machine's own
 * local data, which the signed user owns too, so it is kept on screen and
 * revalidated instead of wiped — wiping it emptied the rail and put the
 * workbench behind "Loading…" on every launch.
 */
export function refreshPrincipalData() {
  // `cancelRefetch: false`: an invalidation that cancels an in-flight fetch
  // rejects that fetch with a CancelledError nothing awaits, which is the
  // unhandled-rejection overlay `clearPrincipalData` guards against. A fetch
  // already in flight is the fresh read we want anyway.
  void queryClient.invalidateQueries(undefined, { cancelRefetch: false }).catch(() => undefined)
}

function userIdOf(principal: Principal | undefined): string | undefined {
  return principal && "userId" in principal && typeof principal.userId === "string" ? principal.userId : undefined
}

/**
 * Same person, more context: the local device becoming the signed user, or a
 * signed user whose organization membership resolves a moment later
 * (`signed` → `org-member` with the same user id). Neither exposes one
 * person's data to another, so the caches are revalidated, not destroyed.
 * A different user, or leaving the signed user (sign-out), is a real change
 * of principal and is still a wipe.
 */
function isSamePersonGainingContext(previous: Principal | undefined, next: Principal): boolean {
  if (!previous) return false
  if (previous.kind === "local" && next.kind !== "local") return true
  const before = userIdOf(previous)
  const after = userIdOf(next)
  return before !== undefined && before === after && previous.kind === "signed" && next.kind === "org-member"
}

export function createPrincipalDataIsolation(input: {
  clear?: () => void
  refresh?: () => void
}) {
  let previousScope: string | undefined
  let previousPrincipal: Principal | undefined
  return (principal: Principal) => {
    const nextScope = principalDataScope(principal)
    const namespaceChanged = setConversationPersistencePrincipal(nextScope)
    if (previousScope === undefined) {
      previousScope = nextScope
      previousPrincipal = principal
      if (namespaceChanged) (input.clear ?? clearPrincipalData)()
      return
    }
    if (previousScope === nextScope) return
    const softened = isSamePersonGainingContext(previousPrincipal, principal)
    previousScope = nextScope
    previousPrincipal = principal
    if (softened) (input.refresh ?? refreshPrincipalData)()
    else (input.clear ?? clearPrincipalData)()
  }
}

export function installPrincipalDataIsolation(input: {
  principal: Accessor<Principal>
  clear?: () => void
}) {
  const transition = createPrincipalDataIsolation(input)
  createComputed(() => transition(input.principal()))
}

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

export function createPrincipalDataIsolation(input: {
  clear?: () => void
}) {
  let previousScope: string | undefined
  return (principal: Principal) => {
    const nextScope = principalDataScope(principal)
    const namespaceChanged = setConversationPersistencePrincipal(nextScope)
    if (previousScope === undefined) {
      previousScope = nextScope
      if (namespaceChanged) (input.clear ?? clearPrincipalData)()
      return
    }
    if (previousScope === nextScope) return
    previousScope = nextScope
    ;(input.clear ?? clearPrincipalData)()
  }
}

export function installPrincipalDataIsolation(input: {
  principal: Accessor<Principal>
  clear?: () => void
}) {
  const transition = createPrincipalDataIsolation(input)
  createComputed(() => transition(input.principal()))
}

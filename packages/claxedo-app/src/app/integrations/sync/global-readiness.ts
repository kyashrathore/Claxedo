import { useGlobalSync } from "@/app/providers/global-sync/provider"
import { onCleanup, onMount } from "solid-js"

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

export type SessionAccessRevocation = {
  sessionId: string
  workspaceId: string
}

export function useSessionAccessRevocations(listener: (event: SessionAccessRevocation) => void) {
  const source = useGlobalSync()
  onMount(() => onCleanup(source.onSessionAccessRevoked(listener)))
}

import { useGlobalSync } from "@/context/global-sync"

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

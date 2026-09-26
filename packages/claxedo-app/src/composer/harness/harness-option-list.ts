import { useQuery } from "@tanstack/solid-query"
import { createMemo } from "solid-js"
import type { Server } from "@/server"
import { NATIVE_HARNESS_IDS, connectionHarness, nativeHarness } from "@/lib/harness-selection"
import { harnessDisplayLabel, type HarnessType } from "./profile"

const BUILTIN_HARNESS_OPTIONS: HarnessType[] = NATIVE_HARNESS_IDS.map(nativeHarness)

export function harnessOptionGroup(input: HarnessType) {
  return input.kind === "native" ? "Native SDK" : "Connections"
}

export function createHarnessOptionList(server: Server) {
  const connections = useQuery(() => server.queries.agentConnections.list())
  const connectionRows = createMemo(() => {
    const catalog = connections.data
    return catalog?.status === "supported" ? catalog.connections : []
  })
  const options = createMemo<HarnessType[]>(() => [
    ...BUILTIN_HARNESS_OPTIONS,
    ...connectionRows()
      .filter((row) => row.enabled)
      .map((row) => connectionHarness(row.connectionId)),
  ])
  const label = (input: HarnessType) => {
    if (input.kind === "connection")
      return (
        connectionRows().find((row) => row.connectionId === input.connectionId)?.label ??
        harnessDisplayLabel(input.connectionId)
      )
    return harnessDisplayLabel(input.harnessId)
  }
  return {
    refetch: () => connections.refetch(),
    connectionRows,
    options,
    label,
  }
}

export type HarnessOptionList = ReturnType<typeof createHarnessOptionList>

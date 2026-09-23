// Zod-backed decoders for process-pane wire payloads, split out of
// process-pane.tsx so they are importable by the SSE handler module and
// unit-testable on their own.

import { Process } from "@/features/processes/data"

export function decodeProcessStatus(value: string): Process.Status | undefined {
  const status = Process.Status.safeParse(value)
  return status.success ? status.data : undefined
}

export function decodeProcessConfigs(values: unknown[]): Process.ProcessConfig[] {
  return values
    .map((value) => Process.ProcessConfig.safeParse(value))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
}

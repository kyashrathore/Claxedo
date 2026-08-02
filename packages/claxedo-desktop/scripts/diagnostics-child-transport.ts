import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { createProcessObserver } from "@claxedo/workspace-runtime"
import { parseLinuxStartTicks } from "../src/main/diagnostics/process-identity"
import {
  matchesDiagnosticsBinding,
  parseDiagnosticsTransportMessage,
  type DiagnosticsBinding,
  type DiagnosticsOperationResult,
  type DiagnosticsOwnerEvent,
} from "../src/shared/diagnostics-transport"

export function createDiagnosticsChildTransport(options: {
  binding: DiagnosticsBinding
  send(message: DiagnosticsOwnerEvent | DiagnosticsOperationResult): void
  revalidateIdentity?: (identity: { pid: number; creation: string }) => Promise<boolean>
}) {
  const operations = new Map<
    string,
    { ownerId: string; ownerGeneration: string; pid?: number }
  >()
  const ownerOperations = new Map<string, string>()
  const requests = new Set<string>()
  const requestOrder: string[] = []
  const observer = createProcessObserver({
    sink(event) {
      if (event.type === "updated" && event.pid !== undefined) {
        const operationId = ownerOperations.get(event.ownerId)
        const operation = operationId ? operations.get(operationId) : undefined
        if (operation?.ownerGeneration === event.ownerGeneration) operation.pid = event.pid
      }
      const message: DiagnosticsOwnerEvent = event.type === "registered"
        ? (() => {
            const ownerOperationId = crypto.randomUUID()
            const previous = ownerOperations.get(event.descriptor.ownerId)
            if (previous) operations.delete(previous)
            ownerOperations.set(event.descriptor.ownerId, ownerOperationId)
            operations.set(ownerOperationId, {
              ownerId: event.descriptor.ownerId,
              ownerGeneration: event.descriptor.ownerGeneration,
              ...(event.descriptor.pid ? { pid: event.descriptor.pid } : {}),
            })
            return {
              type: "owner-registered",
              at: event.at,
              binding: options.binding,
              descriptor: {
                ...event.descriptor,
                ownerOperationId,
                capabilities: event.capabilities,
              },
            }
          })()
        : event.type === "updated"
          ? {
              type: "owner-updated",
              at: event.at,
              binding: options.binding,
              ownerId: event.ownerId,
              ownerGeneration: event.ownerGeneration,
              ...(event.pid ? { pid: event.pid } : {}),
              lifecycle: event.lifecycle,
            }
          : {
              type: "owner-exited",
              at: event.at,
              binding: options.binding,
              ownerId: event.ownerId,
              ownerGeneration: event.ownerGeneration,
              reason: event.reason,
              ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
              observedLifetimeMs: event.observedLifetimeMs,
            }
      const parsed = parseDiagnosticsTransportMessage(message)
      if (parsed.success && parsed.data.type !== "owner-operation-request") {
        options.send(parsed.data)
      }
      if (event.type !== "exited") return
      const operationId = ownerOperations.get(event.ownerId)
      if (operationId) operations.delete(operationId)
      ownerOperations.delete(event.ownerId)
    },
  })

  return {
    observer,
    async onMessage(input: unknown) {
      const parsed = parseDiagnosticsTransportMessage(input)
      if (
        !parsed.success ||
        parsed.data.type !== "owner-operation-request" ||
        !matchesDiagnosticsBinding(parsed.data.binding, options.binding)
      ) return
      const request = parsed.data
      if (requests.has(request.requestId)) {
        sendResult(request.requestId, "duplicate-request")
        return
      }
      requests.add(request.requestId)
      requestOrder.push(request.requestId)
      if (requestOrder.length > 4_096) requests.delete(requestOrder.shift()!)
      const owner = operations.get(request.ownerOperationId)
      if (!owner || owner.ownerGeneration !== request.ownerGeneration) {
        sendResult(request.requestId, "owner-unavailable")
        return
      }
      if (!owner.pid || owner.pid !== request.identity.pid) {
        sendResult(request.requestId, "identity-mismatch")
        return
      }
      if (!await (options.revalidateIdentity ?? revalidateLocalIdentity)(request.identity)) {
        sendResult(request.requestId, "identity-mismatch")
        return
      }
      try {
        sendResult(
          request.requestId,
          await observer.invoke({
            ownerId: owner.ownerId,
            ownerGeneration: owner.ownerGeneration,
            operation: request.operation,
          }),
        )
      } catch {
        sendResult(request.requestId, "operation-failed")
      }
    },
    dispose() {
      operations.clear()
      ownerOperations.clear()
      requests.clear()
      requestOrder.length = 0
      observer.dispose()
    },
  }

  function sendResult(requestId: string, result: DiagnosticsOperationResult["result"]) {
    options.send({
      type: "owner-operation-result",
      binding: options.binding,
      requestId,
      result,
    })
  }
}

async function revalidateLocalIdentity(identity: { pid: number; creation: string }) {
  if (process.platform === "linux") {
    try {
      return parseLinuxStartTicks(await readFile(`/proc/${String(identity.pid)}/stat`, "utf8")) === identity.creation
    } catch {
      return false
    }
  }
  if (process.platform !== "win32") return false
  try {
    const command = windowsIdentityProbeCommand(identity.pid)
    const result = await promisify(execFile)(command.executable, command.args, command.options)
    return /^\d+$/.test(result.stdout.trim()) && result.stdout.trim() === identity.creation
  } catch {
    return false
  }
}

export function windowsIdentityProbeCommand(
  pid: number,
  systemRoot = process.env.SystemRoot ?? String.raw`C:\Windows`,
) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) {
    throw new Error("Windows identity probe PID is invalid")
  }
  return {
    executable: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$ErrorActionPreference='Stop'",
        "$p=[int]$env:CLAXEDO_DIAGNOSTICS_PID",
        "$r=Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = '+$p) -Property ProcessId,CreationDate",
        "if($null -eq $r){exit 3}",
        "[Console]::Out.Write($r.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture))",
      ].join(";"),
    ],
    options: {
      cwd: join(systemRoot, "Temp"),
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        PATH: `${systemRoot}\\System32;${systemRoot}`,
        CLAXEDO_DIAGNOSTICS_PID: String(pid),
      },
      windowsHide: true,
      timeout: 2_000,
      maxBuffer: 4_096,
      encoding: "utf8" as const,
    },
  }
}

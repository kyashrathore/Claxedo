import { asRecord } from "@claxedo/helpers/guards"

export async function refusesWith(operation: () => Promise<unknown>, code: string) {
  try {
    await operation()
    return false
  } catch (error) {
    return asRecord(error)?.code === code
  }
}

export async function rejects(operation: () => Promise<unknown>) {
  try {
    await operation()
    return false
  } catch {
    return true
  }
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Private-session authority conformance failed: ${message}`)
}

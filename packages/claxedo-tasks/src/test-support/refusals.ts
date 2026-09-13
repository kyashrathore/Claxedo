import type { TasksErrorDetail } from "../contracts"
import { TasksError } from "../errors"
import type { Parsed } from "../validation"

/** The detail of the refusal `work` threw; an outcome that resolved is a test failure. */
export async function refusalOf(work: () => Promise<unknown>): Promise<TasksErrorDetail> {
  try {
    await work()
  } catch (cause) {
    if (cause instanceof TasksError) return cause.detail
    throw cause
  }
  throw new Error("Expected the call to be refused, but it resolved")
}

export function fieldReasons(detail: TasksErrorDetail): Record<string, string> {
  return Object.fromEntries((detail.fields ?? []).map((field) => [field.path, field.reason]))
}

export function parsedReasons<T>(result: Parsed<T>): Record<string, string> {
  return result.ok ? {} : Object.fromEntries(result.fields.map((field) => [field.path, field.reason]))
}

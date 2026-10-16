import { parseRegistrations, type EgressRegistration } from "./outbound-credentials"

/** The KV namespace holding each sandbox's brokered values, keyed by sandbox id, outside the container. */
export interface EgressKV {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export async function readRegistrations(store: EgressKV | undefined, sandboxId: string): Promise<EgressRegistration[]> {
  if (!store) return []
  const raw = await store.get(sandboxId)
  return raw === null ? [] : parseRegistrations(JSON.parse(raw))
}

/** Whether `next` names a placeholder `previous` did not, which a running process's environment cannot carry. */
export function placeholderAdded(previous: EgressRegistration[], next: EgressRegistration[]) {
  const held = new Set(previous.map((row) => row.name))
  return next.some((row) => !held.has(row.name))
}

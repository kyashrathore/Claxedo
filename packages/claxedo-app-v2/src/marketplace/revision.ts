import { isAppError } from "@/server"

export function isRevisionConflict(error: unknown) {
  return isAppError(error) && error.class === "conflict"
}

export async function withCurrentRevision<T>(input: {
  readonly revision: () => number | undefined
  readonly reread: () => Promise<void>
  readonly run: (expectedRevision: number) => Promise<T>
}): Promise<T> {
  const first = input.revision()
  if (first === undefined) throw new Error("The plugin catalog is not loaded")
  try {
    return await input.run(first)
  } catch (error) {
    if (!isRevisionConflict(error)) throw error
    await input.reread()
    const next = input.revision()
    if (next === undefined || next === first) throw error
    return await input.run(next)
  }
}

export async function joinFirstFoldSessionPrefetch(input: {
  request: Promise<unknown>
  active: () => boolean
  seed: () => boolean
  onSeed?: () => void
  fallback: () => void | Promise<unknown>
}) {
  try {
    await input.request
  } catch {
    // The authoritative direct transport below is the recovery path.
  }
  if (!input.active()) return "inactive" as const
  if (input.seed()) {
    input.onSeed?.()
    return "seeded" as const
  }
  await input.fallback()
  return "fallback" as const
}

export function shouldScheduleFirstFoldHistory(input: { request?: Promise<unknown> }) {
  return !input.request
}

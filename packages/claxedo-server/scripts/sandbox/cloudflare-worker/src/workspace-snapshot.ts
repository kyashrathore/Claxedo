export const WORKSPACE_SNAPSHOT_MISSING = "This workspace's saved files expired after 30 days unused; start it fresh."

const MISSING_SNAPSHOT = /Snapshot "[^"]*" was not found/

/** A snapshot the platform no longer holds (expired, or never existed) refuses its start with this message and never falls back to the image. */
export function snapshotMissing(error: unknown) {
  return MISSING_SNAPSHOT.test(error instanceof Error ? error.message : String(error))
}

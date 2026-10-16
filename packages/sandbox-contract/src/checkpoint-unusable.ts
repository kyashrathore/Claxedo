export const sandboxCheckpointUnusableCauses = ["expired", "runtime_outdated", "runtime_modified", "not_restorable"] as const

/**
 * Why a workspace's checkpoint cannot be restored: the provider no longer
 * holds its snapshot (`expired`: Cloudflare drops one 30 days after its last
 * restore), the runtime it saved has since had a security fix
 * (`runtime_outdated`), the runtime it saved was changed inside the machine
 * (`runtime_modified`), or the snapshot is not bound to this sandbox
 * (`not_restorable`). Every cause is fixed the same way: the person's Start
 * fresh drops the checkpoint, and the next start boots the image.
 */
export type SandboxCheckpointUnusableCause = (typeof sandboxCheckpointUnusableCauses)[number]

export function isSandboxCheckpointUnusableCause(value: unknown): value is SandboxCheckpointUnusableCause {
  return sandboxCheckpointUnusableCauses.some((cause) => cause === value)
}

export type WorkspaceIdleInput = {
  /** A turn, admitted write or background work; a terminal is not, unless it moved bytes. */
  busy: () => boolean
  frozen: () => boolean
  /** When any terminal last carried input or output. */
  terminalIoAt: () => number
  now?: () => number
}

/**
 * When this workspace last stopped having work, or `undefined` while it has
 * some, and since when a checkpoint has held it frozen. `changed` runs on every
 * activity change it can observe; the readers re-evaluate first, so a change no
 * event reported never reads as idle.
 */
export function createWorkspaceIdle(input: WorkspaceIdleInput) {
  const now = input.now ?? Date.now
  let idleSince: number | undefined
  let frozenSince: number | undefined
  const changed = () => {
    idleSince = input.busy() || input.frozen() ? undefined : idleSince ?? now()
    frozenSince = input.frozen() ? frozenSince ?? now() : undefined
  }
  return {
    changed,
    since() {
      changed()
      return idleSince === undefined ? undefined : Math.max(idleSince, input.terminalIoAt())
    },
    frozenSince() {
      changed()
      return frozenSince
    },
  }
}

export type WorkspaceIdle = ReturnType<typeof createWorkspaceIdle>

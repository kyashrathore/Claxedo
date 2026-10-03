/**
 * When this workspace last stopped having work, or `undefined` while it has
 * some. `changed` runs on every activity change it can observe; `since`
 * re-evaluates first, so a change no event reported never reads as idle.
 */
export function createWorkspaceIdle(busy: () => boolean, now: () => number = Date.now) {
  let idleSince: number | undefined
  const changed = () => {
    idleSince = busy() ? undefined : idleSince ?? now()
  }
  return {
    changed,
    since() {
      changed()
      return idleSince
    },
  }
}

export type WorkspaceIdle = ReturnType<typeof createWorkspaceIdle>

/** A promise its holder resolves, to keep one unit of work open while a second is started. */
export function gate(): { opened: Promise<void>; open: () => void } {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

/**
 * A unit's outcome as a value. Awaiting two overlapping units in order would
 * report the second one's rejection as unhandled while the first is still in
 * flight, so each is turned into a value the moment it is started.
 */
export function settle<T>(unit: Promise<T>): Promise<{ value: T } | { failure: unknown }> {
  return unit.then(
    (value) => ({ value }),
    (failure: unknown) => ({ failure }),
  )
}

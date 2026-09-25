import { retirementSettled, type RetirementResult } from "../../launch"

type Retirable = {
  dispose(): Promise<RetirementResult>
  onExit(listener: (error: Error) => void): () => void
}

/**
 * Launches no session owns (a model probe, a start that failed) whose
 * retirement did not establish that they stopped. Each is retired again when
 * its own leader exits and on every `sweep`, and forgotten only once a
 * retirement settles, so none is left holding the profile open forever.
 */
export function createUnsettledLaunches(onSettled: () => void) {
  const held = new Map<Retirable, RetirementResult>()

  async function retry(launch: Retirable) {
    if (!held.has(launch)) return
    const result = await launch.dispose()
    if (!held.has(launch)) return
    if (!retirementSettled(result)) {
      held.set(launch, result)
      return
    }
    held.delete(launch)
    onSettled()
  }

  return {
    hold(launch: Retirable, result: RetirementResult) {
      if (retirementSettled(result)) return
      held.set(launch, result)
      launch.onExit(() => void retry(launch))
    },
    async sweep() {
      await Promise.all([...held.keys()].map(retry))
    },
    results: (): readonly RetirementResult[] => [...held.values()],
  }
}

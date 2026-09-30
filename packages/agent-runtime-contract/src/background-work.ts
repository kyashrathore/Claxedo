/** Work a harness runs for a session outside any turn, counted by kind. A task the harness marks ambient is not activity and is not counted. */
export type BackgroundWork = { agents: number; shells: number; other: number }

export const NO_BACKGROUND_WORK: BackgroundWork = { agents: 0, shells: 0, other: 0 }

export function backgroundWorkActive(work: BackgroundWork): boolean {
  return work.agents + work.shells + work.other > 0
}

export function sameBackgroundWork(a: BackgroundWork, b: BackgroundWork): boolean {
  return a.agents === b.agents && a.shells === b.shells && a.other === b.other
}

function wholeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function parseBackgroundWork(value: unknown): BackgroundWork | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { agents, shells, other } = value as Record<string, unknown>
  const [a, s, o] = [wholeCount(agents), wholeCount(shells), wholeCount(other)]
  return a === undefined || s === undefined || o === undefined ? undefined : { agents: a, shells: s, other: o }
}

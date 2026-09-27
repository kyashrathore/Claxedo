export type Clock = () => number
export type CreateId = (prefix?: string) => string

export const systemClock: Clock = () => Date.now()

export function createSequentialIdFactory(seed = 0): CreateId {
  let next = seed
  return (prefix = "evt") => `${prefix}_${String(next++).padStart(6, "0")}`
}

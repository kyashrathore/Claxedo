export type RouteParams = Readonly<Record<string, string>>

export function sameRouteParams(a: RouteParams, b: RouteParams): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

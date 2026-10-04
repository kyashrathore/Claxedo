import type { PaneRoute } from "@/shell"

const fields = (route: PaneRoute) => JSON.stringify(Object.entries(route).toSorted(([left], [right]) => left.localeCompare(right)))

export function samePaneRoute(left: PaneRoute | undefined, right: PaneRoute): boolean {
  return !!left && fields(left) === fields(right)
}

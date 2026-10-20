import { createEffect, createMemo, on, type Accessor } from "solid-js"
import type { PageProps } from "@claxedo/plugin-api"
import { sameRouteParams } from "@/lib/route-params"

export type PageParams = PageProps["params"]

export function pageParams(params: Accessor<PageParams>): Accessor<PageParams> {
  return createMemo(params, undefined, { equals: sameRouteParams })
}

export function followPageParams(params: Accessor<PageParams>, opened: PageParams, navigated: (params: PageParams) => void): void {
  let shown = opened
  createEffect(
    on(params, (current) => {
      if (sameRouteParams(current, shown)) return
      shown = current
      navigated(current)
    }),
  )
}

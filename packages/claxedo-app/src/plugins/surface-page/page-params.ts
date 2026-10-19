import { createEffect, createMemo, on, type Accessor } from "solid-js"
import type { PageProps } from "@claxedo/plugin-api"

export type PageParams = PageProps["params"]

function sameParams(left: PageParams, right: PageParams): boolean {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

export function pageParams(params: Accessor<PageParams>): Accessor<PageParams> {
  return createMemo(params, undefined, { equals: sameParams })
}

export function followPageParams(params: Accessor<PageParams>, opened: PageParams, navigated: (params: PageParams) => void): void {
  let shown = opened
  createEffect(
    on(params, (current) => {
      if (sameParams(current, shown)) return
      shown = current
      navigated(current)
    }),
  )
}

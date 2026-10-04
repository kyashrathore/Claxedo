import { createMemo, mapArray, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { FetchQuery } from "@/server"

export function keyedQueries<T>(keys: Accessor<readonly string[]>, options: (key: string) => FetchQuery<T>) {
  const results = mapArray(keys, (key) => [key, useQuery(() => options(key))] as const)
  const byKey = createMemo(() => new Map(results()))
  return (key: string) => byKey().get(key)
}

import { createComponent, createContext, useContext, type JSX, type ParentProps } from "solid-js"
import type { SessionLocation } from "@/server"

const REMEMBERED_HEIGHTS = 64

export type AppHeights = {
  readonly read: (partId: string) => number | undefined
  readonly remember: (partId: string, height: number) => void
}

export type McpAppSession = {
  readonly ref: () => SessionLocation
  readonly heights: AppHeights
}

const McpAppSessionContext = createContext<McpAppSession>()

export function createAppHeights(limit = REMEMBERED_HEIGHTS): AppHeights {
  const heights = new Map<string, number>()
  return {
    read: (partId) => heights.get(partId),
    remember: (partId, height) => {
      heights.delete(partId)
      heights.set(partId, height)
      const oldest = heights.keys().next().value
      if (heights.size > limit && oldest !== undefined) heights.delete(oldest)
    },
  }
}

export function McpAppSessionProvider(props: ParentProps<{ readonly sessionRef: SessionLocation }>): JSX.Element {
  const session: McpAppSession = { ref: () => props.sessionRef, heights: createAppHeights() }
  return createComponent(McpAppSessionContext.Provider, {
    value: session,
    get children() {
      return props.children
    },
  })
}

export function useMcpAppSession(): McpAppSession | undefined {
  return useContext(McpAppSessionContext)
}

export function timelineInteractionPlan(input: { prependLoading: boolean; hasScrollGesture: boolean }) {
  return {
    prepareOverscan: true,
    settlePrependAnchor: !input.prependLoading,
    yieldToUserScroll: input.hasScrollGesture,
  }
}

export function timelineVirtualEntry<Item, Row>(input: {
  rowKey: string
  items: ReadonlyMap<string, Item>
  rows: ReadonlyMap<string, Row>
}) {
  const item = input.items.get(input.rowKey)
  const row = input.rows.get(input.rowKey)
  if (!item || !row) return undefined
  return { item, row }
}

export function timelineInitialRevealVisibility(input: { ready: boolean }) {
  return input.ready ? undefined : "hidden"
}

export function timelineInitialRevealShouldScroll(input: { hasScrollGesture: boolean; shouldAnchorBottom: boolean }) {
  return input.shouldAnchorBottom && !input.hasScrollGesture
}

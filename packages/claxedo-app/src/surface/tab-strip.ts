export type TabStripEdge = "none" | "start" | "end" | "both"

export function tabStripEdge(scrollLeft: number, clientWidth: number, scrollWidth: number): TabStripEdge {
  const hiddenStart = scrollLeft > 1
  const hiddenEnd = scrollLeft + clientWidth < scrollWidth - 1
  if (hiddenStart && hiddenEnd) return "both"
  if (hiddenStart) return "start"
  return hiddenEnd ? "end" : "none"
}

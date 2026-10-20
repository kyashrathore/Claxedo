export function unescapePointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~")
}

export function parsePointer(pointer: string): readonly string[] {
  if (pointer === "" || pointer === "/") return []
  return pointer.slice(1).split("/").map(unescapePointerSegment)
}

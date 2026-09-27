import type { PartGroup, PartRef } from "@claxedo/agent-runtime-contract/turn-fold"

function sameRef(a: PartRef, b: PartRef) {
  return a.messageId === b.messageId && a.partId === b.partId
}

function sameRefs(a: PartRef[], b: PartRef[]) {
  if (a.length !== b.length) return false
  return a.every((ref, i) => sameRef(ref, b[i]))
}

function sameGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "part") {
    if (b.type !== "part") return false
    return sameRef(a.ref, b.ref)
  }
  if (a.type === "work") {
    if (b.type !== "work") return false
    if (a.tool !== b.tool) return false
    return sameRefs(a.refs, b.refs)
  }
  if (a.type === "agents") {
    if (b.type !== "agents") return false
    return sameRefs(a.refs, b.refs)
  }
  if (b.type !== "context") return false
  return sameRefs(a.refs, b.refs)
}

export function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => sameGroup(item, b[i]))
}

export function repoTargetFromText(input: string) {
  const match = /\brepo:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\b/.exec(input)
  if (!match) return
  return {
    owner: match[1]!,
    name: match[2]!,
  }
}

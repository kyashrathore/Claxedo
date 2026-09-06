export function repoTargetFromText(input: string): { owner: string; name: string } | undefined {
  const match = /\brepo:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\b/.exec(input)
  const owner = match?.[1]
  const name = match?.[2]
  if (!owner || !name) return undefined
  return { owner, name }
}

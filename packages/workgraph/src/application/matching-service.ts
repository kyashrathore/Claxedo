import type { StreamID, WorkGraphContext } from "../contracts"

export type MatchableStream = Readonly<{
  id: StreamID
  title: string
  summary: string
  pinned: boolean
  lastActivityAt: number
}>

export type MatchingStreamStore = Readonly<{
  recent(context: WorkGraphContext, limit: number): Promise<readonly MatchableStream[]>
  pinned(context: WorkGraphContext, limit: number): Promise<readonly MatchableStream[]>
}>

export type StreamPlacementMatch = Readonly<{
  streamId: StreamID
  confidence: "high" | "medium" | "low"
  score: number
  explanation: string
}>

export type DuplicateCandidate = Readonly<{
  subject: Readonly<{ type: "outcome"; outcomeId: string }> | Readonly<{ type: "work_item"; workItemId: string }>
  streamId: StreamID
  title: string
  summary: string
  state: string
  updatedAt: number
}>

export function createMatchingService(input: Readonly<{
  streams: MatchingStreamStore
  recentLimit?: number
  pinnedLimit?: number
  clock?: Readonly<{ now: () => number }>
}>) {
  const clock = input.clock ?? { now: Date.now }
  return {
    async suggest(context: WorkGraphContext, candidate: Readonly<{ title: string; body: string }>) {
      const [recent, pinned] = await Promise.all([
        input.streams.recent(context, input.recentLimit ?? 24),
        input.streams.pinned(context, input.pinnedLimit ?? 12),
      ])
      const ranked = rankStreamMatches([...recent, ...pinned], candidate, clock.now())
      return { recommendation: ranked[0], alternatives: ranked.slice(1, 4) }
    },
  }
}

export function rankStreamMatches(
  streams: readonly MatchableStream[],
  candidate: Readonly<{ title: string; body: string }>,
  now: number,
): readonly StreamPlacementMatch[] {
  const titleNeedle = tokens(candidate.title)
  const bodyNeedle = tokens(candidate.body)
  return [...new Map(streams.map((stream) => [stream.id, stream])).values()].map((stream) => {
    const streamTokens = tokens(`${stream.title} ${stream.summary}`)
    const titleOverlap = intersection(titleNeedle, streamTokens)
    const bodyOverlap = intersection(bodyNeedle, streamTokens)
    const overlap = titleOverlap * 0.8 + bodyOverlap * 0.2
    const recency = Math.max(0, 1 - (now - stream.lastActivityAt) / (1000 * 60 * 60 * 24 * 30))
    const raw = Math.min(1, overlap * 0.75 + recency * 0.15 + (stream.pinned ? 0.1 : 0))
    const score = raw
    return {
      streamId: stream.id,
      confidence: score >= 0.72 ? "high" as const : score >= 0.45 ? "medium" as const : "low" as const,
      score,
      explanation: `${stream.pinned ? "Pinned" : "Recent"} stream matched ${Math.round(overlap * 100)}% of meaningful terms.`,
    }
  }).filter((match) => match.score > 0).sort((a, b) => b.score - a.score)
}

export function rankDuplicateMatches(
  candidates: readonly DuplicateCandidate[],
  candidate: Readonly<{ title: string; body: string }>,
  limit = 5,
) {
  const titleNeedle = tokens(candidate.title)
  const fullNeedle = tokens(`${candidate.title} ${candidate.body}`)
  return candidates.map((existing) => {
    const titleOverlap = symmetricOverlap(titleNeedle, tokens(existing.title))
    const contextOverlap = intersection(fullNeedle, tokens(`${existing.title} ${existing.summary}`))
    const score = Math.min(1, titleOverlap * 0.8 + contextOverlap * 0.2)
    return {
      subject: existing.subject,
      streamId: existing.streamId,
      title: existing.title,
      state: existing.state,
      score,
      reason: titleOverlap >= 0.8
        ? "The proposed work has a near-identical title."
        : "The proposed work overlaps an active or recently updated item.",
      evidence: [
        `${Math.round(titleOverlap * 100)}% title-term overlap`,
        `${Math.round(contextOverlap * 100)}% source-context overlap`,
      ],
    }
  }).filter((match) => match.score >= 0.45).sort((left, right) => right.score - left.score).slice(0, limit)
}

export function proposeSourceStructure(source: Readonly<{ title: string; content: string }>) {
  const lines = source.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const description = lines.find((line) => !/^#{1,6}\s|^[-*+]\s|^\d+[.)]\s/.test(line))
  const tasks = lines.flatMap((line) => {
    const match = line.match(/^(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+)$/)
    return match?.[1]?.trim() ? [match[1].trim()] : []
  }).filter((title, index, values) => values.indexOf(title) === index).slice(0, 12)
  const outcomeKey = "outcome_primary"
  return {
    outcomes: [{
      proposalKey: outcomeKey,
      title: source.title,
      ...(description ? { description: description.slice(0, 500) } : {}),
      successCriteria: [`Complete and verify ${source.title}`],
    }],
    workItems: (tasks.length ? tasks : [source.title]).map((title, index) => ({
      proposalKey: `work_item_${index + 1}`,
      outcomeProposalKey: outcomeKey,
      title,
      ...(source.content.trim() ? { description: source.content.trim().slice(0, 1_000) } : {}),
      dependencyProposalKeys: [],
    })),
  }
}

function tokens(value: string) {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2))
}

function intersection(left: Set<string>, right: Set<string>) {
  if (!left.size) return 0
  return [...left].filter((token) => right.has(token)).length / left.size
}

function symmetricOverlap(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0
  const shared = [...left].filter((token) => right.has(token)).length
  return (2 * shared) / (left.size + right.size)
}

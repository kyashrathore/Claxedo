import type { RecapID, StreamID, WorkGraphContext, WorkGraphRecordReference } from "../contracts"

export const RECAP_QUIET_PERIOD_MS = 8 * 60 * 60 * 1000

export type RecapJob = Readonly<{
  streamId: StreamID
  previousRecapId?: RecapID
  fromSequence: number
  toSequence: number
  quietSince: number
}>

export type RecapCandidate = Readonly<{
  streamId: StreamID
  lastActivityAt: number
  latestSequence: number
  quietPeriodMs?: number
  lastRecap?: Readonly<{ id: RecapID; toSequence: number }>
}>

export type RecapPort = Readonly<{
  listCandidates(context: WorkGraphContext): Promise<readonly RecapCandidate[]>
  enqueue(context: WorkGraphContext, job: RecapJob): Promise<"created" | "existing">
  complete(
    context: WorkGraphContext,
    job: RecapJob,
    output: RecapGeneratorOutput,
  ): Promise<void>
}>

export type RecapGeneratorOutput = Readonly<{
  summary: string
  actionableReferences: readonly WorkGraphRecordReference[]
  generation: Readonly<{
    method: "agent_session"
    sessionId: string
  }>
}>

export type RecapGenerator = Readonly<{
  generate(input: RecapJob): Promise<RecapGeneratorOutput>
}>

export function createRecapService(port: RecapPort, clock: Readonly<{ now(): number }>) {
  return {
    scheduleDue: async (context: WorkGraphContext) => {
      const now = clock.now()
      const due = (await port.listCandidates(context)).filter((candidate) =>
        now - candidate.lastActivityAt >= (candidate.quietPeriodMs ?? RECAP_QUIET_PERIOD_MS) &&
        candidate.latestSequence > (candidate.lastRecap?.toSequence ?? 0),
      )
      const results = await Promise.all(due.map((candidate) => port.enqueue(context, {
        streamId: candidate.streamId,
        ...(candidate.lastRecap ? { previousRecapId: candidate.lastRecap.id } : {}),
        fromSequence: (candidate.lastRecap?.toSequence ?? 0) + 1,
        toSequence: candidate.latestSequence,
        quietSince: candidate.lastActivityAt,
      })))
      return results.filter((result) => result === "created").length
    },
    run: async (context: WorkGraphContext, job: RecapJob, generator: RecapGenerator) => {
      const output = await generator.generate(job)
      await port.complete(context, job, output)
      return output
    },
  }
}

/** Worker-safe admission matching and source-structure primitives. */
export {
  proposeSourceStructure,
  rankDuplicateMatches,
  rankStreamMatches,
  type DuplicateCandidate,
  type MatchableStream,
  type StreamPlacementMatch,
} from "./application/matching-service"

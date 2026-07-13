/** Worker-safe WorkGraph composition surface. */
export { createWorkGraphService, type WorkGraphService } from "./application/workgraph-service"
export { createWorkGraphHttpRouter } from "./http/router"
export type { WorkGraphHttpService, WorkGraphTrustedContextResolver } from "./http/contracts"
export {
  defineAtomicWorkGraphStore,
  type WorkGraphCommandHandler,
  type WorkGraphCommandHandlers,
} from "./ports/store"
export type {
  AtomicWorkGraphStore,
  OwnerQuery,
  WorkGraphCommandRequestOf,
  WorkGraphCommandType,
} from "./ports/store"
export {
  createIntakeService,
  IntakeCandidateNotFoundError,
  IntakeCandidateVersionConflictError,
  IntakeStateError,
} from "./application/intake-service"
export {
  createWebhookIntakeService,
  matchesFilters,
} from "./application/webhook-intake-service"
export { createNotificationService, NotificationVersionConflictError } from "./application/notification-service"
export {
  createSourceViewService,
  SourceViewConnectionError,
  SourceViewFilterError,
  SourceViewInUseError,
  SourceViewNotFoundError,
  SourceViewVersionConflictError,
} from "./application/source-view-service"
export {
  proposeSourceStructure,
  rankDuplicateMatches,
  rankStreamMatches,
} from "./application/matching-service"
export {
  createGitHubSourceIssueConnector,
  createLinearSourceIssueConnector,
  createJiraSourceIssueConnector,
} from "./connectors"
export type {
  ExternalIntakeCandidate,
  IntakeCandidate,
  IntakeCandidateStore,
  IntakeReceiptStore,
  VerifiedWorkSourceSignal,
  WebhookIntakeStore,
  NotificationStore,
  SourceView,
  SourceViewStore,
} from "./application"
export type { ConnectionsPort } from "./ports"

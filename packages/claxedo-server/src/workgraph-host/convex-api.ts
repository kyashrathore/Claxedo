import { anyApi, type FunctionReference } from "convex/server"

type ConvexQuery = FunctionReference<"query">
type ConvexMutation = FunctionReference<"mutation">

type WorkGraphConvexApi = {
  workgraphCommands: {
    execute: ConvexMutation
    executeForService: ConvexMutation
  }
  workgraphChanges: {
    read: ConvexQuery
    readForService: ConvexQuery
  }
  workgraphAttention: {
    acknowledgeForService: ConvexMutation
  }
  workgraphIntake: {
    readForService: ConvexQuery
    executeForService: ConvexMutation
    readWebhookForService: ConvexQuery
    executeWebhookForService: ConvexMutation
  }
  workgraphNotifications: {
    readForService: ConvexQuery
    executeForService: ConvexMutation
  }
  workgraphArchive: {
    exportForService: ConvexQuery
    restoreForService: ConvexMutation
  }
  workgraphOwnerDeletion: {
    prepareForService: ConvexMutation
    renewForService: ConvexMutation
    finalizeForService: ConvexMutation
    releaseForService: ConvexMutation
  }
  workgraphCapabilities: {
    attestForService: ConvexMutation
    readForService: ConvexQuery
  }
  workgraphConnections: {
    resolveWebhookMetadata: ConvexQuery
  }
}

export const workGraphConvexApi = anyApi as unknown as WorkGraphConvexApi

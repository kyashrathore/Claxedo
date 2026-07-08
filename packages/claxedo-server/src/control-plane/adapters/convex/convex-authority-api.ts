import { anyApi, type FunctionReference } from "convex/server"

type ConvexQuery = FunctionReference<"query">
type ConvexMutation = FunctionReference<"mutation">

type ConvexApi = {
  channelIdentities: {
    authorizeProject: ConvexQuery
    authorizeWorkspace: ConvexQuery
  }
  users: { me: ConvexMutation }
  orgs: {
    listForMe: ConvexQuery
    resolveForMe: ConvexMutation
  }
  projects: {
    role: ConvexQuery
    authorize: ConvexQuery
  }
  sessions: {
    authorizeRead: ConvexQuery
    list: ConvexQuery
    readMessages: ConvexQuery
    syncMessages: ConvexMutation
    syncMessagesForService: ConvexMutation
    upsertVisibility: ConvexMutation
    upsertVisibilityForService: ConvexMutation
    replaceVisibility: ConvexMutation
    replaceVisibilityForService: ConvexMutation
    deleteVisibility: ConvexMutation
    deleteVisibilityForService: ConvexMutation
  }
  workspaces: {
    open: ConvexQuery
    list: ConvexQuery
    listForService: ConvexQuery
    registerLocalForSharing: ConvexMutation
    registerLocalForSharingForService: ConvexMutation
    delete: ConvexMutation
    createCloud: ConvexMutation
  }
  localHostLinks: {
    createChallenge: ConvexMutation
    createChallengeForService: ConvexMutation
    register: ConvexMutation
    registerForService: ConvexMutation
    heartbeat: ConvexMutation
    heartbeatForService: ConvexMutation
    pause: ConvexMutation
    pauseForService: ConvexMutation
    active: ConvexQuery
  }
  workspaceShares: {
    grant: ConvexMutation
    revoke: ConvexMutation
  }
  runtimeAccessTokens: {
    recordMint: ConvexMutation
    active: ConvexQuery
    revoke: ConvexMutation
    revokeForWorkspaceUser: ConvexMutation
  }
  agentExtensions: {
    list: ConvexQuery
    listForRuntime: ConvexQuery
    authorizeAdmin: ConvexQuery
    upsert: ConvexMutation
    setEnabled: ConvexMutation
    delete: ConvexMutation
  }
  agentExtensionPolicies: {
    list: ConvexQuery
    listForRuntime: ConvexQuery
    set: ConvexMutation
    delete: ConvexMutation
  }
  auditEvents: { record: ConvexMutation }
}

export const convexApi = anyApi as unknown as ConvexApi

import { anyApi, type FunctionReference } from "convex/server"

type ConvexQuery = FunctionReference<"query">
type ConvexMutation = FunctionReference<"mutation">

type ConvexApi = {
  channelIdentities: {
    authorizeProject: ConvexQuery
    authorizeWorkspace: ConvexQuery
    bind: ConvexMutation
    revoke: ConvexMutation
  }
  users: { me: ConvexMutation; meForService: ConvexMutation }
  orgs: {
    listForMe: ConvexQuery
    resolveForMe: ConvexMutation
    createTeam: ConvexMutation
  }
  teams: {
    listForOrg: ConvexQuery
    create: ConvexMutation
    addMember: ConvexMutation
    removeMember: ConvexMutation
    listMembers: ConvexQuery
    grantProject: ConvexMutation
    revokeProject: ConvexMutation
    ensureDefaultTeamForOrg: ConvexMutation
  }
  projects: {
    role: ConvexQuery
    authorize: ConvexQuery
  }
  sessions: {
    authorizeRead: ConvexQuery
    authorizeWrite: ConvexQuery
    authorizeRuntime: ConvexQuery
    registerRuntime: ConvexMutation
    addParticipant: ConvexMutation
    removeParticipant: ConvexMutation
    list: ConvexQuery
    resolve: ConvexQuery
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
  sessionShares: {
    grant: ConvexMutation
    revoke: ConvexMutation
    list: ConvexQuery
  }
  privateSessions: {
    reserve: ConvexMutation
    registerRuntime: ConvexMutation
    markRegistrationAmbiguous: ConvexMutation
    beginCompensation: ConvexMutation
    completeCompensation: ConvexMutation
    authorizeRead: ConvexQuery
    authorizeWrite: ConvexQuery
    authorizeRuntime: ConvexQuery
    grantParticipant: ConvexMutation
    revokeParticipant: ConvexMutation
    list: ConvexQuery
    resolve: ConvexQuery
    readMessages: ConvexQuery
    syncMessages: ConvexMutation
    acquireTurn: ConvexMutation
    renewTurn: ConvexMutation
    releaseTurn: ConvexMutation
    upsertVisibility: ConvexMutation
    replaceVisibility: ConvexMutation
    deleteVisibility: ConvexMutation
  }
  workspaces: {
    authorizeCreate: ConvexQuery
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
    markSecondDeviceOpen: ConvexMutation
    active: ConvexQuery
  }
  hostEnrollments: {
    createRequest: ConvexMutation
    createRequestForService: ConvexMutation
    enroll: ConvexMutation
    enrollForService: ConvexMutation
    heartbeat: ConvexMutation
    heartbeatForService: ConvexMutation
    pause: ConvexMutation
    pauseForService: ConvexMutation
    active: ConvexQuery
    activeForService: ConvexQuery
  }
  workspaceShares: {
    grant: ConvexMutation
    revoke: ConvexMutation
  }
  runtimeAccessTokens: {
    recordMint: ConvexMutation
    recordMintForService: ConvexMutation
    active: ConvexQuery
    revoke: ConvexMutation
    revokeForWorkspaceUser: ConvexMutation
  }
  cliSessionTokens: {
    recordMint: ConvexMutation
    rotate: ConvexMutation
    active: ConvexQuery
    revoke: ConvexMutation
    revokeSession: ConvexMutation
    revokeForUser: ConvexMutation
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

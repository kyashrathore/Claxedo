/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentExtensionPolicies from "../agentExtensionPolicies.js";
import type * as agentExtensions from "../agentExtensions.js";
import type * as auditEvents from "../auditEvents.js";
import type * as billing from "../billing.js";
import type * as channelIdentities from "../channelIdentities.js";
import type * as clerkReconcile from "../clerkReconcile.js";
import type * as clerkTombstones from "../clerkTombstones.js";
import type * as cliSessionTokens from "../cliSessionTokens.js";
import type * as connectionAttempts from "../connectionAttempts.js";
import type * as cronLease from "../cronLease.js";
import type * as crons from "../crons.js";
import type * as hostEnrollments from "../hostEnrollments.js";
import type * as http from "../http.js";
import type * as idempotency from "../idempotency.js";
import type * as localHostLinks from "../localHostLinks.js";
import type * as migrations from "../migrations.js";
import type * as model from "../model.js";
import type * as orgs from "../orgs.js";
import type * as projectMemberships from "../projectMemberships.js";
import type * as projects from "../projects.js";
import type * as runtimeAccessTokens from "../runtimeAccessTokens.js";
import type * as sandboxLeases from "../sandboxLeases.js";
import type * as sessionShares from "../sessionShares.js";
import type * as sessions from "../sessions.js";
import type * as teams from "../teams.js";
import type * as usageMetering from "../usageMetering.js";
import type * as users from "../users.js";
import type * as wakes from "../wakes.js";
import type * as workgraphActivity from "../workgraphActivity.js";
import type * as workgraphArchive from "../workgraphArchive.js";
import type * as workgraphAttention from "../workgraphAttention.js";
import type * as workgraphBackground from "../workgraphBackground.js";
import type * as workgraphCapabilities from "../workgraphCapabilities.js";
import type * as workgraphChanges from "../workgraphChanges.js";
import type * as workgraphCommands from "../workgraphCommands.js";
import type * as workgraphConnections from "../workgraphConnections.js";
import type * as workgraphIntake from "../workgraphIntake.js";
import type * as workgraphModel from "../workgraphModel.js";
import type * as workgraphOwnerDeletion from "../workgraphOwnerDeletion.js";
import type * as workgraphRuntime from "../workgraphRuntime.js";
import type * as workspaceShares from "../workspaceShares.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentExtensionPolicies: typeof agentExtensionPolicies;
  agentExtensions: typeof agentExtensions;
  auditEvents: typeof auditEvents;
  billing: typeof billing;
  channelIdentities: typeof channelIdentities;
  clerkReconcile: typeof clerkReconcile;
  clerkTombstones: typeof clerkTombstones;
  cliSessionTokens: typeof cliSessionTokens;
  connectionAttempts: typeof connectionAttempts;
  cronLease: typeof cronLease;
  crons: typeof crons;
  hostEnrollments: typeof hostEnrollments;
  http: typeof http;
  idempotency: typeof idempotency;
  localHostLinks: typeof localHostLinks;
  migrations: typeof migrations;
  model: typeof model;
  orgs: typeof orgs;
  projectMemberships: typeof projectMemberships;
  projects: typeof projects;
  runtimeAccessTokens: typeof runtimeAccessTokens;
  sandboxLeases: typeof sandboxLeases;
  sessionShares: typeof sessionShares;
  sessions: typeof sessions;
  teams: typeof teams;
  usageMetering: typeof usageMetering;
  users: typeof users;
  wakes: typeof wakes;
  workgraphActivity: typeof workgraphActivity;
  workgraphArchive: typeof workgraphArchive;
  workgraphAttention: typeof workgraphAttention;
  workgraphBackground: typeof workgraphBackground;
  workgraphCapabilities: typeof workgraphCapabilities;
  workgraphChanges: typeof workgraphChanges;
  workgraphCommands: typeof workgraphCommands;
  workgraphConnections: typeof workgraphConnections;
  workgraphIntake: typeof workgraphIntake;
  workgraphModel: typeof workgraphModel;
  workgraphOwnerDeletion: typeof workgraphOwnerDeletion;
  workgraphRuntime: typeof workgraphRuntime;
  workspaceShares: typeof workspaceShares;
  workspaces: typeof workspaces;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
};

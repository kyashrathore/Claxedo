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
import type * as channelIdentities from "../channelIdentities.js";
import type * as http from "../http.js";
import type * as localHostLinks from "../localHostLinks.js";
import type * as model from "../model.js";
import type * as orgs from "../orgs.js";
import type * as projectMemberships from "../projectMemberships.js";
import type * as projects from "../projects.js";
import type * as runtimeAccessTokens from "../runtimeAccessTokens.js";
import type * as sessions from "../sessions.js";
import type * as users from "../users.js";
import type * as sandboxLeases from "../sandboxLeases.js";
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
  channelIdentities: typeof channelIdentities;
  http: typeof http;
  localHostLinks: typeof localHostLinks;
  model: typeof model;
  orgs: typeof orgs;
  projectMemberships: typeof projectMemberships;
  projects: typeof projects;
  runtimeAccessTokens: typeof runtimeAccessTokens;
  sessions: typeof sessions;
  users: typeof users;
  sandboxLeases: typeof sandboxLeases;
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

export declare const components: {};

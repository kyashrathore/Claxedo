/**
 * Every product-boundary policy, and which package's `verify:closure` owns it.
 *
 * `@claxedo/cloud-app` has no policy here. Unit 10 of
 * `docs/plans/2026-08-07-004-refactor-local-cloud-package-split-plan.md` is
 * DEFERRED — the package does not exist — so a `cloud-app` policy would be a
 * file that can never run, which is the same "reads as coverage" failure this
 * directory exists to prevent. The plan's cloud-app bullets are unmet, not met.
 */

import type { Policy } from "../policy.ts"
import { appLocal } from "./app-local.ts"
import { localServer } from "./local-server.ts"
import { hostConnector } from "./host-connector.ts"
import { serverCloudNode, serverSelfHosted, serverWorkerd } from "./server.ts"
import {
  desktopAccountComposition,
  desktopHostedContribution,
  desktopMainComposition,
  desktopRendererUnsigned,
} from "./desktop.ts"

export const POLICIES: Policy[] = [
  appLocal,
  localServer,
  hostConnector,
  serverCloudNode,
  serverWorkerd,
  serverSelfHosted,
  desktopMainComposition,
  desktopAccountComposition,
  desktopRendererUnsigned,
  desktopHostedContribution,
]

/** Package name -> the policies its `verify:closure` runs. */
export const PRODUCTS: Record<string, string[]> = {
  "@claxedo/app": ["app-local"],
  "@claxedo/local-server": ["local-server"],
  "@claxedo/host-connector": ["host-connector"],
  "@claxedo/server": ["server-cloud-node", "server-workerd", "server-self-hosted"],
  "@claxedo/desktop": [
    "desktop-main-composition",
    "desktop-account-composition",
    "desktop-renderer-unsigned",
    "desktop-hosted-contribution",
  ],
}

export function policyById(id: string): Policy | undefined {
  return POLICIES.find((policy) => policy.id === id)
}

/**
 * Every product-boundary policy, and which package's `verify:closure` owns it.
 *
 * There is no `@claxedo/cloud-app` package, so there is no policy for one. A
 * policy that can never run would read as coverage.
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

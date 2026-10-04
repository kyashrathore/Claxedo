/**
 * Every product-boundary policy, and which package's `verify:closure` owns it.
 *
 * There is no `@claxedo/cloud-app` package, so there is no policy for one. A
 * policy that can never run would read as coverage.
 */

import type { Policy } from "../policy.ts"
import { localServer } from "./local-server.ts"
import { hostConnector } from "./host-connector.ts"
import { serverWorkerd } from "./server.ts"
import { desktopAccountComposition, desktopMainComposition, desktopRenderer } from "./desktop.ts"

export const POLICIES: Policy[] = [
  localServer,
  hostConnector,
  serverWorkerd,
  desktopMainComposition,
  desktopAccountComposition,
  desktopRenderer,
]

/** Package name -> the policies its `verify:closure` runs. */
export const PRODUCTS: Record<string, string[]> = {
  "@claxedo/local-server": ["local-server"],
  "@claxedo/host-connector": ["host-connector"],
  "@claxedo/server": ["server-workerd"],
  "@claxedo/desktop": [
    "desktop-main-composition",
    "desktop-account-composition",
    "desktop-renderer",
  ],
}

export function policyById(id: string): Policy | undefined {
  return POLICIES.find((policy) => policy.id === id)
}

import { expect, test } from "vitest"
import * as egressBroker from "./index.js"

/**
 * One authority per responsibility: the binding lifecycle — activation,
 * rotation, withdrawal and the auth mode a projection carries — belongs to the
 * server that holds the credential values, and a second copy of it here drifted
 * from `destinationAuthMode` until `x-goog-api-key` projected as bearer.
 */
test("the package exposes request policy and token minting, and no binding authority of its own", () => {
  expect(Object.keys(egressBroker).sort()).toEqual([
    "BROKER_ROUTE_PATTERN",
    "bindingBaseUrl",
    "brokerErrorBody",
    "createEgressBroker",
    "isBrokerPath",
    "loopbackBrokerRoutes",
    "mintRuntimeToken",
    "sameRuntime",
    "verifyRuntimeToken",
  ])
})

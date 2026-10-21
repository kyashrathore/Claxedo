import { expect, test } from "vitest"
import { controlPlaneSteps } from "./control-plane-workers"

test("reading at the edge deploys the writer, moves the routes off it, then deploys the edge that takes them", () => {
  for (const edgeDeployed of [false, true]) {
    expect(controlPlaneSteps({ edgeReads: true, edgeDeployed })).toEqual([
      { kind: "deploy", worker: "writer" },
      { kind: "release-routes", from: "writer" },
      { kind: "deploy", worker: "edge" },
    ])
  }
})

test("turning edge reads off moves the routes off the edge, deploys the one Worker with them, then deletes the edge", () => {
  expect(controlPlaneSteps({ edgeReads: false, edgeDeployed: true })).toEqual([
    { kind: "release-routes", from: "edge" },
    { kind: "deploy", worker: "writer" },
    { kind: "delete", worker: "edge" },
  ])
})

test("with edge reads off and no edge Worker, the deploy is the one Worker it was before the split", () => {
  expect(controlPlaneSteps({ edgeReads: false, edgeDeployed: false })).toEqual([{ kind: "deploy", worker: "writer" }])
})

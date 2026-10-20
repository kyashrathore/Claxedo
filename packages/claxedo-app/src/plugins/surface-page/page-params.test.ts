import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { followPageParams, pageParams, type PageParams } from "./page-params"

function followed(initial: PageParams) {
  const [route, setRoute] = createSignal(initial)
  const navigations: PageParams[] = []
  const dispose = createRoot((disposeRoot) => {
    const params = pageParams(route)
    followPageParams(params, params(), (params) => navigations.push(params))
    return disposeRoot
  })
  return { setRoute, navigations, dispose }
}

describe("a surface page's route params", () => {
  test("a param change reaches the open program; the params it opened with and a reparse with the same values do not", () => {
    const { setRoute, navigations, dispose } = followed({})
    setRoute({})
    expect(navigations).toEqual([])
    setRoute({ taskId: "tsk_1" })
    setRoute({ taskId: "tsk_1" })
    setRoute({ taskId: "tsk_2" })
    setRoute({})
    expect(navigations).toEqual([{ taskId: "tsk_1" }, { taskId: "tsk_2" }, {}])
    dispose()
    setRoute({ taskId: "tsk_3" })
    expect(navigations).toHaveLength(3)
  })

  test("a change that lands before the follow's first run still reaches the program, as when a deep link's page registers late", () => {
    const [route, setRoute] = createSignal<PageParams>({})
    const navigations: PageParams[] = []
    const dispose = createRoot((disposeRoot) => {
      const params = pageParams(route)
      followPageParams(params, params(), (next) => navigations.push(next))
      setRoute({ taskId: "tsk_1" })
      return disposeRoot
    })
    expect(navigations).toEqual([{ taskId: "tsk_1" }])
    dispose()
  })
})

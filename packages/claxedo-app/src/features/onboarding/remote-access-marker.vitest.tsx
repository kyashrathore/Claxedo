import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { createMemoryHistory, MemoryRouter, Route, useLocation } from "@solidjs/router"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { RemoteAccessMarkerRecorder } from "./remote-access-marker"
import { SECOND_DEVICE_STASH_KEY } from "./remote-access-state"

const port = vi.hoisted(() => ({
  markSecondDeviceOpen: vi.fn(async () => ({ recorded: true })),
}))

vi.mock("@/platform/remote-access/machine-remote-access", () => ({
  machineRemoteAccess: () => port,
}))

/** This device's own client id. A marker naming it proves nothing. */
const THIS_CLIENT = "phone-client"

/**
 * Mount the recorder on a real router at `path`, and expose that router's
 * navigation so a test can perform the second leg as a navigation rather than
 * a remount.
 */
function mountAt(path: string) {
  const history = createMemoryHistory()
  history.set({ value: path })
  let search = ""
  render(() => (
    <MemoryRouter history={history}>
      <Route
        path="*"
        component={() => {
          const location = useLocation()
          return (
            <>
              <RemoteAccessMarkerRecorder />
              {(() => {
                search = location.search
                return null
              })()}
            </>
          )
        }}
      />
    </MemoryRouter>
  ))
  return {
    /** Where the router thinks it is — the URL a user would see. */
    url: () => history.get(),
    search: () => search,
    goTo: (next: string) => history.set({ value: next }),
  }
}

beforeEach(() => {
  port.markSecondDeviceOpen.mockClear()
  window.sessionStorage.clear()
  window.localStorage.setItem("claxedo.remote-access.client-id", THIS_CLIENT)
})

afterEach(() => cleanup())

describe("second-device marker handoff", () => {
  test("leg 1 — the marker lands on the ROOT, is stashed, and leaves the URL", async () => {
    // Machine-level sharing points the QR at the app root, so there is no
    // workspace to attribute yet. Nothing may be recorded here.
    const router = mountAt("/?claxedo_second_device=1&claxedo_source_client=desktop-client")

    await waitFor(() =>
      expect(window.sessionStorage.getItem(SECOND_DEVICE_STASH_KEY)).toBe("desktop-client"),
    )
    expect(port.markSecondDeviceOpen).not.toHaveBeenCalled()
    // Stripped, so a reload cannot re-arm a marker this device already holds.
    await waitFor(() => expect(router.url()).not.toContain("claxedo_second_device"))
    expect(router.url()).not.toContain("claxedo_source_client")
  })

  test("leg 2 — the first workspace this device opens is recorded, and the stash clears", async () => {
    const router = mountAt("/?claxedo_second_device=1&claxedo_source_client=desktop-client")
    await waitFor(() =>
      expect(window.sessionStorage.getItem(SECOND_DEVICE_STASH_KEY)).toBe("desktop-client"),
    )

    router.goTo("/w/ws_phone/session")

    await waitFor(() => expect(port.markSecondDeviceOpen).toHaveBeenCalledWith({
      workspaceId: "ws_phone",
      sourceClientId: "desktop-client",
      currentClientId: THIS_CLIENT,
    }))
    expect(window.sessionStorage.getItem(SECOND_DEVICE_STASH_KEY)).toBeNull()
  })

  test("the marker is spent once — a later workspace does not record again", async () => {
    const router = mountAt("/?claxedo_second_device=1&claxedo_source_client=desktop-client")
    await waitFor(() =>
      expect(window.sessionStorage.getItem(SECOND_DEVICE_STASH_KEY)).toBe("desktop-client"),
    )

    router.goTo("/w/ws_phone/session")
    await waitFor(() => expect(port.markSecondDeviceOpen).toHaveBeenCalledTimes(1))

    router.goTo("/w/ws_second/session")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(port.markSecondDeviceOpen).toHaveBeenCalledTimes(1)
  })

  test("a reload after the marker was spent records nothing", async () => {
    // Leg 2 leaves an empty stash and a stripped URL. Re-mounting on that
    // state is exactly what a reload does — and the stripping is what makes
    // this true, because the params would otherwise still be in the address
    // bar to re-arm.
    const first = mountAt("/?claxedo_second_device=1&claxedo_source_client=desktop-client")
    await waitFor(() =>
      expect(window.sessionStorage.getItem(SECOND_DEVICE_STASH_KEY)).toBe("desktop-client"),
    )
    first.goTo("/w/ws_phone/session")
    await waitFor(() => expect(port.markSecondDeviceOpen).toHaveBeenCalledTimes(1))
    const reloadedUrl = first.url()
    cleanup()
    port.markSecondDeviceOpen.mockClear()

    mountAt(reloadedUrl)

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(port.markSecondDeviceOpen).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem(SECOND_DEVICE_STASH_KEY)).toBeNull()
  })

  test("a link that already names a workspace still records in one pass", async () => {
    mountAt("/w/ws_direct/session?claxedo_second_device=1&claxedo_source_client=desktop-client")

    await waitFor(() => expect(port.markSecondDeviceOpen).toHaveBeenCalledWith({
      workspaceId: "ws_direct",
      sourceClientId: "desktop-client",
      currentClientId: THIS_CLIENT,
    }))
    expect(window.sessionStorage.getItem(SECOND_DEVICE_STASH_KEY)).toBeNull()
  })

  test("this machine following its own link proves nothing", async () => {
    mountAt(`/?claxedo_second_device=1&claxedo_source_client=${THIS_CLIENT}`)

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(window.sessionStorage.getItem(SECOND_DEVICE_STASH_KEY)).toBeNull()
    expect(port.markSecondDeviceOpen).not.toHaveBeenCalled()
  })
})

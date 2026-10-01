import { beforeEach, expect, test, vi } from "vitest"
import { resetStagingD1 } from "./reset-staging-d1"

const wrangler = vi.hoisted(() => ({ run: vi.fn(), probe: vi.fn() }))
vi.mock("./wrangler-cli", () => ({ runWrangler: wrangler.run, probeWrangler: wrangler.probe }))
beforeEach(() => { wrangler.run.mockReset(); wrangler.probe.mockReset() })

test("reset requires the explicit staging control-plane name before touching Cloudflare", async () => {
  await expect(resetStagingD1({})).rejects.toThrow(/CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_NAME/)
  expect(wrangler.run).not.toHaveBeenCalled()
  expect(wrangler.probe).not.toHaveBeenCalled()
})

test("reset deletes only the selected staging database and recreates it with a new UUID", async () => {
  const name = "control-plane-staging"
  wrangler.probe.mockResolvedValue({ code: 0, stdout: "", stderr: "" })
  wrangler.run.mockResolvedValueOnce("[]").mockResolvedValueOnce("").mockResolvedValueOnce(JSON.stringify([
    { name, uuid: "11111111-1111-4111-8111-111111111111" },
  ]))
  await expect(resetStagingD1({ CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_NAME: name })).resolves.toEqual({ id: "11111111-1111-4111-8111-111111111111", created: true })
  expect(wrangler.probe).toHaveBeenCalledWith(["d1", "delete", name, "--skip-confirmation"])
  expect(wrangler.run.mock.calls.map(([args]) => args)).toEqual([
    ["d1", "list", "--json"], ["d1", "create", name], ["d1", "list", "--json"],
  ])
})

test("a failed delete stops before recreation", async () => {
  wrangler.probe.mockResolvedValue({ code: 1, stdout: "", stderr: "permission denied" })
  await expect(resetStagingD1({ CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_NAME: "staging" })).rejects.toThrow(/permission denied/)
  expect(wrangler.run).not.toHaveBeenCalled()
})

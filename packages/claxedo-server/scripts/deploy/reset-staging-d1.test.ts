import { beforeEach, expect, test, vi } from "vitest"
import { resetStagingD1 } from "./reset-staging-d1"

const wrangler = vi.hoisted(() => ({ run: vi.fn(), probe: vi.fn() }))
vi.mock("./wrangler-cli", () => ({ runWrangler: wrangler.run, probeWrangler: wrangler.probe }))
beforeEach(() => { wrangler.run.mockReset(); wrangler.probe.mockReset() })

const name = "control-plane-staging"
const env = { CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_NAME: name }

test.each([
  ["no configured name", {}, ["--confirm", name], /CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_NAME/],
  ["no confirmation", env, [], /--confirm <staging control-plane D1 name>/],
  ["a confirmation naming another database", env, ["--confirm", "claxedo-control-plane"], /does not name the configured staging control-plane D1 control-plane-staging/],
  ["the auth database's name", { ...env, CLAXEDO_AUTH_D1_DATABASE_NAME: name }, ["--confirm", name], /must differ from AUTH_DB/],
] as const)("reset with %s touches nothing in Cloudflare", async (_, environment, args, error) => {
  await expect(resetStagingD1(environment, args)).rejects.toThrow(error)
  expect(wrangler.run).not.toHaveBeenCalled()
  expect(wrangler.probe).not.toHaveBeenCalled()
})

test("a confirmed reset deletes only the configured staging database and recreates it with a new UUID", async () => {
  wrangler.probe.mockResolvedValue({ code: 0, stdout: "", stderr: "" })
  wrangler.run.mockResolvedValueOnce("[]").mockResolvedValueOnce("").mockResolvedValueOnce(JSON.stringify([
    { name, uuid: "11111111-1111-4111-8111-111111111111" },
  ]))
  await expect(resetStagingD1(env, ["--confirm", name])).resolves.toEqual({ id: "11111111-1111-4111-8111-111111111111", created: true })
  expect(wrangler.probe.mock.calls).toEqual([[["d1", "delete", name, "--skip-confirmation"]]])
  expect(wrangler.run.mock.calls.map(([args]) => args)).toEqual([
    ["d1", "list", "--json"], ["d1", "create", name], ["d1", "list", "--json"],
  ])
})

test("a failed delete stops before recreation", async () => {
  wrangler.probe.mockResolvedValue({ code: 1, stdout: "", stderr: "permission denied" })
  await expect(resetStagingD1(env, ["--confirm", name])).rejects.toThrow(/permission denied/)
  expect(wrangler.run).not.toHaveBeenCalled()
})

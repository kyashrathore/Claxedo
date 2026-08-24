import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { SourceViewForm } from "./connections"

afterEach(cleanup)

const connection = {
  id: "connection_1",
  integrationId: "github",
  scope: "team" as const,
  accountLabel: "Acme",
  grantedCapabilities: ["work-source"],
  fields: {},
  status: "connected" as const,
  createdAt: 1,
  updatedAt: 1,
}

const localProject = {
  id: "/projects/claxedo",
  label: "Claxedo",
  target: {
    environment: { kind: "local_worktree" as const, placement: "shared" as const, directory: "/projects/claxedo" },
    repository: { remoteUrl: "https://github.com/acme/claxedo.git", baseRevision: "HEAD" },
  },
}

describe("SourceViewForm", () => {
  test("infers a GitHub cloud target from owner/repository", async () => {
    const onSave = vi.fn(async () => {})
    render(() => (
      <SourceViewForm
        connection={connection}
        provider="github"
        projects={[]}
        busy={false}
        onCancel={() => {}}
        onSave={onSave}
      />
    ))

    await fireEvent.input(screen.getByLabelText(/Your provider identity/), { target: { value: "octocat" } })
    await fireEvent.input(screen.getByLabelText(/Repository/), { target: { value: "acme/cloud" } })
    await fireEvent.click(screen.getByRole("button", { name: "Save source" }))

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "github",
          providerUserId: "octocat",
          filters: { repo: "acme/cloud", state: "open" },
          target: {
            environment: {
              kind: "hosted_workspace",
              placement: "shared",
              repositoryUrl: "https://github.com/acme/cloud.git",
            },
            repository: { remoteUrl: "https://github.com/acme/cloud.git", baseRevision: "HEAD" },
          },
        }),
      ),
    )
  })

  test.each(["linear", "jira"] as const)("requires an explicit project mapping for %s", async (provider) => {
    const onSave = vi.fn(async () => {})
    const view = render(() => (
      <SourceViewForm
        connection={{ ...connection, integrationId: provider }}
        provider={provider}
        projects={[]}
        busy={false}
        onCancel={() => {}}
        onSave={onSave}
      />
    ))
    await fireEvent.input(screen.getByLabelText(/Your provider identity/), { target: { value: "user-1" } })
    expect(screen.getByRole("button", { name: "Save source" })).toBeDisabled()
    view.unmount()

    render(() => (
      <SourceViewForm
        connection={{ ...connection, integrationId: provider }}
        provider={provider}
        projects={[localProject]}
        busy={false}
        onCancel={() => {}}
        onSave={onSave}
      />
    ))
    await fireEvent.input(screen.getByLabelText(/Your provider identity/), { target: { value: "user-1" } })
    await fireEvent.change(screen.getByLabelText(/Project/), { target: { value: localProject.id } })
    await fireEvent.click(screen.getByRole("button", { name: "Save source" }))
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ provider, target: localProject.target })),
    )
  })

  test("keeps an edited mapping attached to its project when the base revision differs", () => {
    render(() => (
      <SourceViewForm
        connection={connection}
        provider="github"
        projects={[localProject]}
        busy={false}
        onCancel={() => {}}
        onSave={async () => {}}
        view={
          {
            id: "source-view-1",
            ownerUserId: "user-1",
            version: 1,
            teamConnectionId: connection.id,
            provider: "github",
            providerUserId: "octocat",
            filters: { repo: "acme/claxedo" },
            target: {
              ...localProject.target,
              repository: { ...localProject.target.repository, baseRevision: "develop" },
            },
            syncPolicy: "announce",
            status: "active",
            createdAt: 1,
            updatedAt: 1,
          } as never
        }
      />
    ))

    expect(screen.getByLabelText(/Project/)).toHaveValue(localProject.id)
    expect(screen.getByLabelText(/Base revision/)).toHaveValue("develop")
  })
})

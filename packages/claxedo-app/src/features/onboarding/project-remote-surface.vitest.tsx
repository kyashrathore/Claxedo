import { render, screen } from "@solidjs/testing-library"
import { describe, expect, test, vi } from "vitest"
import { ProjectRemoteSurface } from "./project-remote-surface"
import type { DerivedRemote } from "./project-remote-api"

const origin: DerivedRemote = {
  name: "origin",
  url: "https://github.com/kyashrathore/formlink.git",
  display: "https://github.com/kyashrathore/formlink",
  transport: "https",
  credentialsStripped: false,
}

const upstream: DerivedRemote = {
  ...origin,
  name: "upstream",
  url: "https://github.com/anomalyco/opencode.git",
  display: "https://github.com/anomalyco/opencode",
}

describe("ProjectRemoteSurface", () => {
  test("an origin is shown and confirmed before anything is created", () => {
    const onConfirm = vi.fn()
    render(() => (
      <ProjectRemoteSurface result={{ kind: "origin", remote: origin, remotes: [origin] }} onConfirm={onConfirm} />
    ))

    expect(screen.getByText("https://github.com/kyashrathore/formlink")).toBeInTheDocument()
    screen.getByRole("button", { name: /Use this remote/i }).click()
    expect(onConfirm).toHaveBeenCalledWith(origin)
  })

  test("a confirmed remote reads as settled rather than as work to redo", () => {
    render(() => (
      <ProjectRemoteSurface
        result={{ kind: "origin", remote: origin, remotes: [origin] }}
        confirmed={origin}
        onConfirm={vi.fn()}
      />
    ))

    expect(screen.getByText("Confirmed")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Use this remote/i })).not.toBeInTheDocument()
  })

  test("ambiguous asks rather than guesses, listing every candidate", () => {
    const onConfirm = vi.fn()
    render(() => (
      <ProjectRemoteSurface result={{ kind: "ambiguous", remotes: [upstream, origin] }} onConfirm={onConfirm} />
    ))

    expect(screen.getByText(/no remote named origin/i)).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: /Clone this one/i })).toHaveLength(2)
    screen.getAllByRole("button", { name: /Clone this one/i })[0]!.click()
    expect(onConfirm).toHaveBeenCalledWith(upstream)
  })

  test("a folder with no remote explains why cloud is unavailable and offers a URL field", () => {
    const onManualUrl = vi.fn()
    render(() => <ProjectRemoteSurface result={{ kind: "no_remote" }} onConfirm={vi.fn()} onManualUrl={onManualUrl} />)

    expect(screen.getByText(/nothing for a cloud sandbox to clone/i)).toBeInTheDocument()
    expect(screen.getByLabelText("Repository URL")).toBeInTheDocument()
  })

  test("a non-repo folder says local work is unaffected", () => {
    render(() => <ProjectRemoteSurface result={{ kind: "not_a_repo" }} onConfirm={vi.fn()} onManualUrl={vi.fn()} />)

    expect(screen.getByText(/Local agents work here either way/i)).toBeInTheDocument()
  })

  test("a timeout says so and offers a retry", () => {
    const onRetry = vi.fn()
    render(() => <ProjectRemoteSurface result={{ kind: "git_timeout" }} onConfirm={vi.fn()} onRetry={onRetry} />)

    expect(screen.getByText(/took too long/i)).toBeInTheDocument()
    screen.getByRole("button", { name: /Try again/i }).click()
    expect(onRetry).toHaveBeenCalled()
  })

  test("a remote that carried a credential says so, and never renders the url", () => {
    const stripped: DerivedRemote = { ...origin, url: "https://TOKEN@github.com/o/r.git", credentialsStripped: true }
    const { container } = render(() => (
      <ProjectRemoteSurface result={{ kind: "origin", remote: stripped, remotes: [stripped] }} onConfirm={vi.fn()} />
    ))

    expect(screen.getByText(/had a credential embedded in it/i)).toBeInTheDocument()
    // Only `display` is render-safe; the transport url must never reach the DOM.
    expect(container.textContent).not.toContain("TOKEN")
  })

  test("an SSH remote warns that a sandbox has no key for it", () => {
    render(() => (
      <ProjectRemoteSurface
        result={{ kind: "origin", remote: { ...origin, transport: "ssh" }, remotes: [] }}
        onConfirm={vi.fn()}
      />
    ))

    expect(screen.getByText(/no SSH key/i)).toBeInTheDocument()
  })

  test("a private repository is named as needing a connection or a token", () => {
    render(() => (
      <ProjectRemoteSurface result={{ kind: "origin", remote: origin, remotes: [origin] }} onConfirm={vi.fn()} />
    ))

    expect(screen.getByText(/connection or an access token/i)).toBeInTheDocument()
  })

  test("shows progress while the derivation runs", () => {
    render(() => <ProjectRemoteSurface loading onConfirm={vi.fn()} />)

    expect(screen.getByText(/Reading this folder's git remotes/i)).toBeInTheDocument()
  })
})

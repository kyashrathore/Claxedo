import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, expect, test } from "vitest"

import { AppInterface } from "./app"

afterEach(() => cleanup())

test("mounts the hosted OAuth consent component from the direct route spine", async () => {
  window.history.replaceState({}, "", "/oauth/consent?scope=workspace%3Aread")

  render(() => (
    <AppInterface oauthConsent={() => <h1>Hosted consent route</h1>} />
  ))

  expect(await screen.findByRole("heading", { name: "Hosted consent route" })).toBeInTheDocument()
})

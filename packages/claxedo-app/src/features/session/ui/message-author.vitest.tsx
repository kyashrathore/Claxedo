import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, test } from "vitest"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { MessageAuthorLane, messageAuthor } from "./message-author"

function userMessage(claxedo?: unknown) {
  return {
    id: "msg_1",
    sessionID: "ses_1",
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-4o" },
    ...(claxedo === undefined ? {} : { claxedo }),
  } as Message
}

describe("message author lane", () => {
  test("leaves the unsigned message markup byte-identical", () => {
    const view = render(() => (
      <MessageAuthorLane message={userMessage()}>
        <div data-testid="existing-message">hello</div>
      </MessageAuthorLane>
    ))

    expect(view.container.innerHTML).toBe('<div data-testid="existing-message">hello</div>')
  })

  test("renders the display-safe avatar and ignores authority-shaped fields", () => {
    const message = userMessage({
      author: {
        id: "user_public_123",
        name: "Yash Singh",
        avatarUrl: "https://example.invalid/avatar",
        kind: "human",
        actorId: "internal_actor_123",
        subject: "clerk|secret",
      },
    })
    const view = render(() => (
      <MessageAuthorLane message={message}>
        <div>hello</div>
      </MessageAuthorLane>
    ))

    expect(messageAuthor(message)).toEqual({
      id: "user_public_123",
      name: "Yash Singh",
      avatarUrl: "https://example.invalid/avatar",
      kind: "human",
    })
    expect(screen.getByRole("img", { name: "Yash Singh" })).toHaveAttribute(
      "src",
      "https://example.invalid/avatar",
    )
    expect(view.container.textContent).not.toContain("internal_actor_123")
    expect(view.container.textContent).not.toContain("clerk|secret")
  })

  test("falls back from a missing or broken avatar to initials, then the generic icon", () => {
    const withInitials = render(() => (
      <MessageAuthorLane message={userMessage({ author: {
        id: "user_public_123",
        name: "Yash Singh",
        avatarUrl: "https://example.invalid/avatar",
        kind: "human",
      } })}>
        <div>hello</div>
      </MessageAuthorLane>
    ))
    fireEvent.error(screen.getByRole("img", { name: "Yash Singh" }))
    expect(withInitials.container.querySelector('[data-slot="message-author-initials"]')?.textContent).toBe("YS")

    const generic = render(() => (
      <MessageAuthorLane message={userMessage({ author: {
        id: "user_public_456",
        name: "",
        kind: "human",
      } })}>
        <div>hello</div>
      </MessageAuthorLane>
    ))
    expect(generic.container.querySelector('[data-slot="message-author-generic"]')).not.toBeNull()
  })

  test("renders each participant's own message author", () => {
    const view = render(() => (
      <>
        <MessageAuthorLane message={userMessage({ author: {
          id: "user_public_yash",
          name: "Yash Singh",
          kind: "human",
        } })}>
          <div>first</div>
        </MessageAuthorLane>
        <MessageAuthorLane message={userMessage({ author: {
          id: "user_public_ada",
          name: "Ada Lovelace",
          kind: "human",
        } })}>
          <div>second</div>
        </MessageAuthorLane>
      </>
    ))

    expect(
      [...view.container.querySelectorAll('[data-slot="message-author-initials"]')].map((node) => node.textContent),
    ).toEqual(["YS", "AL"])
  })
})

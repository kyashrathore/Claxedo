import { describe, expect, test } from "bun:test"
import { createHostedContributionPort, HostedContributionError } from "./hosted-contribution-port"

type Contribution = { id: string }

/**
 * One port plus the composition it was handed, so every test can read what the
 * composition actually saw rather than what the port claims it did.
 */
function harness(options: {
  signedIn?: boolean
  load?: () => Promise<readonly Contribution[]>
  registered?: string[]
} = {}) {
  const registered = options.registered ?? []
  const events: string[] = []
  let signedIn = options.signedIn ?? true
  let loads = 0

  const port = createHostedContributionPort<Contribution>({
    signedIn: () => signedIn,
    load:
      options.load ??
      (async () => {
        loads += 1
        return [{ id: "hosted.workgraph" }, { id: "hosted.documents" }]
      }),
    register: (contribution) => {
      registered.push(contribution.id)
      events.push(`register:${contribution.id}`)
    },
    unregister: (contribution) => {
      const index = registered.indexOf(contribution.id)
      if (index !== -1) registered.splice(index, 1)
      events.push(`unregister:${contribution.id}`)
    },
    registeredIds: () => registered,
  })

  return {
    port,
    registered,
    events,
    loads: () => loads,
    signOut: () => {
      signedIn = false
    },
    signIn: () => {
      signedIn = true
    },
  }
}

describe("the account gate", () => {
  test("refuses to activate for an unsigned window, and loads nothing", async () => {
    let loads = 0
    const app = harness({
      signedIn: false,
      load: async () => {
        loads += 1
        return [{ id: "hosted.workgraph" }]
      },
    })

    await expect(app.port.activate()).rejects.toThrow(HostedContributionError)
    expect(loads).toBe(0)
    expect(app.registered).toEqual([])
    expect(app.port.active()).toBe(false)
  })

  test("names the reason with a code, not only a message", async () => {
    const app = harness({ signedIn: false })

    const error = await app.port.activate().then(
      () => expect.unreachable("an unsigned window must not activate"),
      (reason: unknown) => reason as HostedContributionError,
    )

    // On the CODE: the message is prose a reword may change, the code is what a
    // caller branches on.
    expect(error.code).toBe("account_not_signed")
  })

  test("abandons an activation when the account signs out MID-LOAD", async () => {
    // The window the pre-load check cannot cover: a cold chunk load is a
    // network round trip, and a sign-out inside it used to register hosted
    // surfaces into an app that no longer had an account.
    let release: (() => void) | undefined
    const app = harness({
      load: async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return [{ id: "hosted.workgraph" }]
      },
    })

    const activation = app.port.activate()
    app.signOut()
    release!()

    const error = await activation.then(
      () => expect.unreachable("signing out mid-load must abandon the activation"),
      (reason: unknown) => reason as HostedContributionError,
    )
    expect(error.code).toBe("account_not_signed")
    expect(app.registered).toEqual([])
    expect(app.port.active()).toBe(false)
  })

  test("abandons an activation that was deactivated MID-LOAD", async () => {
    let release: (() => void) | undefined
    const app = harness({
      load: async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return [{ id: "hosted.workgraph" }]
      },
    })

    const activation = app.port.activate()
    app.port.deactivate()
    release!()

    const error = await activation.then(
      () => expect.unreachable("deactivating mid-load must abandon the activation"),
      (reason: unknown) => reason as HostedContributionError,
    )
    // Its OWN code: "the caller pulled the plug" is not "there is no account",
    // and a reader chasing an abandoned activation should not be sent looking
    // for a sign-out that never happened.
    expect(error.code).toBe("activation_abandoned")
    expect(app.registered).toEqual([])
  })
})

describe("activation happens at most once", () => {
  test("concurrent callers share one load and one registration", async () => {
    const app = harness()

    await Promise.all([app.port.activate(), app.port.activate(), app.port.activate()])

    expect(app.loads()).toBe(1)
    expect(app.registered).toEqual(["hosted.workgraph", "hosted.documents"])
  })

  test("an already-active port short-circuits without re-reading the account", async () => {
    let reads = 0
    const registered: string[] = []
    let loads = 0
    const port = createHostedContributionPort<Contribution>({
      signedIn: () => {
        reads += 1
        return true
      },
      load: async () => {
        loads += 1
        return [{ id: "hosted.workgraph" }]
      },
      register: (contribution) => registered.push(contribution.id),
      unregister: () => {},
      registeredIds: () => registered,
    })

    await port.activate()
    const readsAfterFirst = reads
    await port.activate()

    expect(loads).toBe(1)
    expect(reads).toBe(readsAfterFirst)
    expect(registered).toEqual(["hosted.workgraph"])
  })
})

describe("failure is not cached, the loaded bundle is", () => {
  test("a failed load can be retried, and the retry registers", async () => {
    // The bug this covers: caching the REJECTED promise disabled hosted mode
    // for the life of the window, so one transient chunk-load failure left a
    // signed user in a local-only app until they reloaded the page.
    let attempts = 0
    const registered: string[] = []
    const port = createHostedContributionPort<Contribution>({
      signedIn: () => true,
      load: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("chunk load failed")
        return [{ id: "hosted.workgraph" }]
      },
      register: (contribution) => registered.push(contribution.id),
      unregister: () => {},
      registeredIds: () => registered,
    })

    await expect(port.activate()).rejects.toThrow(/chunk load failed/)
    expect(port.active()).toBe(false)

    await port.activate()

    expect(attempts).toBe(2)
    expect(registered).toEqual(["hosted.workgraph"])
  })

  test("sign-out then sign-in re-registers from the cached bundle, without loading again", async () => {
    const app = harness()

    await app.port.activate()
    app.signOut()
    app.port.deactivate()
    app.signIn()
    await app.port.activate()

    expect(app.loads()).toBe(1)
    expect(app.registered).toEqual(["hosted.workgraph", "hosted.documents"])
  })

  test("an activation abandoned mid-load keeps the bundle it already loaded", async () => {
    // The load SUCCEEDED; only the registration was abandoned. Re-importing the
    // chunk on the next sign-in would buy nothing.
    let release: (() => void) | undefined
    let loads = 0
    const app = harness({
      load: async () => {
        loads += 1
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return [{ id: "hosted.workgraph" }]
      },
    })

    const activation = app.port.activate()
    app.signOut()
    release!()
    await activation.catch(() => {})

    app.signIn()
    await app.port.activate()

    expect(loads).toBe(1)
    expect(app.registered).toEqual(["hosted.workgraph"])
  })
})

describe("deactivation", () => {
  test("unregisters in reverse registration order", async () => {
    // Reverse, so a contribution installed on top of another comes off first —
    // the same discipline as tearing down nested resources.
    const app = harness({
      load: async () => [{ id: "hosted.a" }, { id: "hosted.b" }, { id: "hosted.c" }],
    })

    await app.port.activate()
    app.port.deactivate()

    expect(app.events).toEqual([
      "register:hosted.a",
      "register:hosted.b",
      "register:hosted.c",
      "unregister:hosted.c",
      "unregister:hosted.b",
      "unregister:hosted.a",
    ])
  })

  test("removes the hosted set and leaves local registrations alone", async () => {
    const app = harness({ registered: ["local.session", "local.terminal"] })

    await app.port.activate()
    expect(app.registered).toEqual([
      "local.session",
      "local.terminal",
      "hosted.workgraph",
      "hosted.documents",
    ])

    app.port.deactivate()

    expect(app.registered).toEqual(["local.session", "local.terminal"])
    expect(app.port.active()).toBe(false)
  })

  test("is idempotent, and unregisters nothing when the port never activated", () => {
    const app = harness()

    app.port.deactivate()
    app.port.deactivate()

    expect(app.events).toEqual([])
  })

  test("does not unregister the same contribution twice", async () => {
    const app = harness({ load: async () => [{ id: "hosted.workgraph" }] })

    await app.port.activate()
    app.port.deactivate()
    app.port.deactivate()

    expect(app.events).toEqual(["register:hosted.workgraph", "unregister:hosted.workgraph"])
  })
})

describe("duplicate ids are refused, all or nothing", () => {
  test("a hosted contribution that would shadow a registered one is refused", async () => {
    const app = harness({
      registered: ["local.session"],
      load: async () => [{ id: "hosted.workgraph" }, { id: "local.session" }],
    })

    const error = await app.port.activate().then(
      () => expect.unreachable("a shadowing id must be refused"),
      (reason: unknown) => reason as HostedContributionError,
    )

    expect(error.code).toBe("shadows_registered_contribution")
    // Nothing registered: a partial set would leave `hosted.workgraph`
    // installed with no way to remove it, because the port never took
    // ownership of it.
    expect(app.registered).toEqual(["local.session"])
    expect(app.port.active()).toBe(false)
  })

  test("two contributions inside one hosted set sharing an id are refused, with their own code", async () => {
    const app = harness({
      load: async () => [{ id: "hosted.documents" }, { id: "hosted.documents" }],
    })

    const error = await app.port.activate().then(
      () => expect.unreachable("a duplicate id must be refused"),
      (reason: unknown) => reason as HostedContributionError,
    )

    expect(error.code).toBe("duplicate_contribution_id")
    expect(app.registered).toEqual([])
  })

  test("a refused set leaves nothing for deactivate to remove", async () => {
    const app = harness({
      load: async () => [{ id: "hosted.a" }, { id: "hosted.a" }],
    })

    await app.port.activate().catch(() => {})
    app.port.deactivate()

    expect(app.events).toEqual([])
  })
})

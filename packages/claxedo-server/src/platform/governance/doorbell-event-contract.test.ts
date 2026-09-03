import { describe, expect, expectTypeOf, test } from "vitest"
import type { DocumentChangedEvent as ServerDocumentChangedEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import type { DocumentChangedEvent as AppDocumentChangedEvent } from "../../../../claxedo-app/src/features/documents/data/document-changed-event"

// Doorbell mirror contract.
//
// The `document.changed` envelope is declared TWICE:
// the canonical server union in `./bus` (claxedo-server, publisher) and the
// frontend mirror module in claxedo-app (consumer). claxedo-app does not depend
// on claxedo-server (the `runtime contract` test forbids that import edge), so
// TypeScript cannot see the two copies at once inside either package's own
// program — drift between them compiles clean on both sides.
//
// This file is the one place that imports BOTH. It is legal here because:
//   1. `runtime-contract.test.ts` scans PRODUCTION source only — it skips
//      `*.test.*` files — so a test importing the app mirror does not violate
//      the sibling-src import ban.
//   2. claxedo-server's tsconfig includes `src` and does NOT exclude tests, so
//      `tsgo -b` type-checks this file. The app mirror module is a pure
//      type-only file with zero imports, so pulling it into the server
//      program needs no alias resolution and adds no runtime edge.
//
// Enforcement is entirely at compile time: the cross-assignments below fail to
// type-check the moment either mirror gains, loses, renames, or retypes a field
// (or flips a field's optionality), so `tsgo -b` — a required gate — goes red on
// drift. The `expectTypeOf` exact-equality checks add the same guarantee under
// `vitest --typecheck`. The runtime bodies exist only so this is a valid,
// runnable vitest file; the real check is the types.

describe("doorbell event mirror contract", () => {
  test("document.changed server envelope and app mirror stay identical", () => {
    expectTypeOf<ServerDocumentChangedEvent>().toEqualTypeOf<AppDocumentChangedEvent>()
    expectTypeOf<AppDocumentChangedEvent>().toEqualTypeOf<ServerDocumentChangedEvent>()

    const fromServer: ServerDocumentChangedEvent = {
      type: "document.changed",
      documentId: "doc",
      orgId: "org",
      projectId: "project",
      version: "1",
      ts: 0,
    }
    const asApp: AppDocumentChangedEvent = fromServer
    const backToServer: ServerDocumentChangedEvent = asApp
    expect(backToServer.type).toBe("document.changed")
  })
})

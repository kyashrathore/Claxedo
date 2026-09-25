# Wire corpus

Run one passing flow by its filename stem, without `.flow.ts`. Run the package script inside the same isolation wrapper as the flow suite:

```sh
../_control/isolated-test.sh "$PWD" env CLAXEDO_E2E_PORT_RANGE=47100-47199 bun run --cwd packages/harness corpus H0-smoke record
../_control/isolated-test.sh "$PWD" env CLAXEDO_E2E_PORT_RANGE=47100-47199 bun run --cwd packages/harness corpus H0-smoke compare
../_control/isolated-test.sh "$PWD" env CLAXEDO_E2E_PORT_RANGE=47100-47199 bun run --cwd packages/harness corpus all compare
```

The flow runner refuses variants in `../flows/expected-red.json`. Their asserted defect changes the wire when fixed. `excluded.json` lists passing flows that have a recording but cannot gate a cutover yet. A batch comparison skips those files and fails if any other passing flow lacks a recording. Batch runs assign each flow a different daemon port inside `CLAXEDO_E2E_PORT_RANGE` so a just-closed stack cannot hold the next flow's port.

Each HTTP observation keeps its method, route, status, and reply body. A stream observation groups frames by the entity the payload describes: session, message, part, permission, question, child session, goal, or terminal. Runtime diagnostics use their session key. Group keys, frame counts, content, and order **inside** each group must match. Frames about different entities can interleave differently because those producers run independently. A same-session reorder remains a mismatch. HTTP calls remain in the flow's observed order, including recovery replies and refusals.

Readbacks belong in the corpus only after the flow awaits the event that establishes the state it reads. Permission and question flows await `permission.asked` or `question.asked` before reading pending requests; completed turns await `session.idle`; Pi title reads await the title-bearing `session.updated`. This omits transient polling snapshots while preserving the flow's assertions. `H7.unknown-held` has no event that establishes the queue's `unknown` state, so its queue GET polling is omitted from its corpus until the producer exposes one. Internal `/api/claxedo/health` startup probes are omitted because they may return an intermediate status while a stack starts; H0's explicit health assertion remains recorded. `H35.intermediate-release` asserts only the final session ID. Its GET retains the status and ID, which were established by session creation, while dropping the unsettled title field.

IDs get one placeholder per original value across HTTP and stream channels. The normalizer processes HTTP observations first, then frame groups in stable entity order, so cross-entity scheduling cannot renumber unrelated IDs. Timestamps, observed times, deadlines, durations, leased ports, PIDs, and temporary paths use placeholders. `state` and `phase` keep their exact values. The compact files omit the SSE envelope's generated cursor `id` and redundant `event` name. They also omit payload-free transport heartbeats, which have no entity and whose count depends on elapsed time; all product event payloads remain. Usage replies keep the totals and breakdown the flows assert; filter choices, charts, quota metadata, and other presentation fields are dropped after the client has consumed them.

Named faults prove the boundary:

```sh
../_control/isolated-test.sh "$PWD" env CLAXEDO_E2E_PORT_RANGE=47100-47199 CLAXEDO_E2E_CORPUS_FAULT=rename-frame-field bun run --cwd packages/harness corpus H0-smoke compare
../_control/isolated-test.sh "$PWD" env CLAXEDO_E2E_PORT_RANGE=47100-47199 CLAXEDO_E2E_CORPUS_FAULT=same-key-reorder bun run --cwd packages/harness corpus H0-smoke compare
../_control/isolated-test.sh "$PWD" env CLAXEDO_E2E_PORT_RANGE=47100-47199 CLAXEDO_E2E_CORPUS_FAULT=cross-key-swap bun run --cwd packages/harness corpus H0-smoke compare
```

The first two comparisons must fail; the cross-key swap must pass. The flow itself receives the original frames.

# Wire corpus

Run one passing flow by its filename stem, without `.flow.ts`. Run the package script inside the same isolation wrapper as the flow suite:

```sh
../_control/isolated-test.sh "$PWD" env CLAXEDO_E2E_PORT_RANGE=47400-47499 bun run --cwd packages/harness corpus H0-smoke record
../_control/isolated-test.sh "$PWD" env CLAXEDO_E2E_PORT_RANGE=47400-47499 bun run --cwd packages/harness corpus H0-smoke compare
../_control/isolated-test.sh "$PWD" env CLAXEDO_E2E_PORT_RANGE=47400-47499 bun run --cwd packages/harness corpus all compare
```

The flow runner refuses variants in `../flows/expected-red.json`. Their asserted defect changes the wire when fixed. `excluded.json` lists passing flows that have a recording but cannot gate a cutover yet. A batch comparison skips those files and fails if any other passing flow lacks a recording. Batch runs assign each flow a different daemon port inside `CLAXEDO_E2E_PORT_RANGE` so a just-closed stack cannot hold the next flow's port.

Each HTTP observation keeps its method, route, status, and reply body. A stream observation groups frames by the entity the payload describes: session, message, part, permission, question, child session, goal, or terminal. Ordinary runtime diagnostics use their session key. Group keys, frame counts, content, and order **inside** each group must match. Frames about different entities can interleave differently because those producers run independently. A same-session reorder remains a mismatch. HTTP calls remain in the flow's observed order, including recovery replies and refusals.

Readbacks belong in the corpus only after the flow awaits the event that establishes the state it reads. Permission and question flows await `permission.asked` or `question.asked` before reading pending requests; completed turns await `session.idle`; Pi title reads await the title-bearing `session.updated`. This omits transient polling snapshots while preserving the flow's assertions. `H7.unknown-held` has no event that establishes the queue's `unknown` state, so its queue GET polling is omitted from its corpus until the producer exposes one. Internal `/api/claxedo/health` startup probes are omitted because they may return an intermediate status while a stack starts; H0's explicit health assertion remains recorded. `H35.intermediate-release` asserts only the final session ID. Its GET retains the status and ID, which were established by session creation, while dropping the unsettled title field. `H35.native-handoff` also awaits `session.idle` and asserts the ID, but never awaits a title-bearing update; its session GET drops the unsettled `title` and `titleSource` fields while keeping the other readback fields.

IDs get one placeholder per original value across HTTP and stream channels. Placeholders are numbered within each HTTP observation or stream entity after the observations are placed in stable order. An extra ID in one entity therefore does not renumber another entity. The original-value map is shared, so one ID retains its placeholder across channels. Timestamps, observed times, deadlines, durations, leased ports, PIDs, and temporary paths use placeholders. `state` and `phase` keep their exact values. The compact files omit the SSE envelope's generated cursor `id` and redundant `event` name. They also omit payload-free transport heartbeats, which have no entity and whose count depends on elapsed time; all product event payloads remain. Usage replies keep the totals and breakdown the flows assert; filter choices, charts, quota metadata, and other presentation fields are dropped after the client has consumed them.

Status and vendor diagnostic frames use the **latest status per subject** rule. It covers `runtime.mcp_server_status` keyed by server name, harness `*.unmapped_event` keyed by source method and native event subtype, Claude initialization diagnostics through that unmapped-event rule, and Codex `runtime.rate_limit` keyed by limit ID within the session. Their final full frame must match, but intermediate count and position are ignored. Vendor startup and notification timing can add intermediate frames; clients render the latest state and do not use their arrival order to establish a turn. Other diagnostics and all other frames remain ordered within their entity.

Named faults prove the boundary:

```sh
../_control/isolated-test.sh "$PWD" env CLAXEDO_E2E_PORT_RANGE=47400-47499 CLAXEDO_E2E_CORPUS_FAULT=rename-frame-field bun run --cwd packages/harness corpus H0-smoke compare
../_control/isolated-test.sh "$PWD" env CLAXEDO_E2E_PORT_RANGE=47400-47499 CLAXEDO_E2E_CORPUS_FAULT=same-key-reorder bun run --cwd packages/harness corpus H0-smoke compare
../_control/isolated-test.sh "$PWD" env CLAXEDO_E2E_PORT_RANGE=47400-47499 CLAXEDO_E2E_CORPUS_FAULT=cross-key-swap bun run --cwd packages/harness corpus H0-smoke compare
../_control/isolated-test.sh "$PWD" env CLAXEDO_E2E_PORT_RANGE=47400-47499 CLAXEDO_E2E_CORPUS_FAULT=status-final-value bun run --cwd packages/harness corpus H1-turn-parts compare
../_control/isolated-test.sh "$PWD" env CLAXEDO_E2E_PORT_RANGE=47400-47499 CLAXEDO_E2E_CORPUS_FAULT=status-extra-intermediate bun run --cwd packages/harness corpus H1-turn-parts compare
```

The first two comparisons must fail; the cross-key swap must pass. `status-final-value` must fail and `status-extra-intermediate` must pass on a flow with MCP status frames, such as `H1-turn-parts`. The wire comparator unit test plants an extra ID in one entity and checks that another entity keeps the same placeholders. The flow itself receives the original frames.

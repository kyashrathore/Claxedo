# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: playwright/core-harness-rendering-matrix.spec.ts >> core harness rendering matrix @core >> an interrupted Codex command stays interrupted when rail-return replay resends its start
- Location: e2e/playwright/core-harness-rendering-matrix.spec.ts:886:3

# Error details

```
Error: the stored interrupted command returned to Running after its start frames replayed

expect(received).toBe(expected) // Object.is equality

Expected: false
Received: true
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e3]:
    - button "Skip to composer" [ref=e4]
    - generic [ref=e5]:
      - navigation [ref=e6]:
        - navigation "Projects and sessions" [ref=e9]:
          - button "Hide Sidebar" [pressed] [ref=e13]:
            - img [ref=e14]
          - generic [ref=e16]:
            - generic [ref=e17]:
              - button "New Project" [ref=e18]:
                - img [ref=e20]
                - generic [ref=e22]: New Project
              - button "Open Marketplace" [ref=e23]:
                - img [ref=e25]
                - generic [ref=e27]: Marketplace
            - generic [ref=e28]:
              - generic [ref=e29]: Projects
              - generic [ref=e30]:
                - generic [ref=e32] [cursor=pointer]:
                  - button "Collapse project" [expanded] [ref=e33]:
                    - img [ref=e34]
                  - generic "mock-runtime · e2e-interrupted-replay" [ref=e36]: mock-runtime
                - generic [ref=e38]:
                  - generic [ref=e39]:
                    - button "Other session" [ref=e40]
                    - generic:
                      - generic: Other session
                    - generic [ref=e42]: now
                  - generic [ref=e43]:
                    - button "Run the bounded command" [ref=e44]
                    - generic:
                      - generic: Run the bounded command
                    - generic [ref=e45]:
                      - generic [ref=e46]: now
                      - button "Archive Run the bounded command" [ref=e47] [cursor=pointer]:
                        - img [ref=e49]
          - button "Test User" [ref=e53]:
            - generic [ref=e54]: T
            - generic [ref=e55]: Test User
            - img [ref=e56]
      - main [ref=e60]:
        - generic [ref=e61]:
          - generic [ref=e63]:
            - generic [ref=e64]:
              - button "New Session" [ref=e66]:
                - img [ref=e67]
              - button "New Terminal" [ref=e70]:
                - img [ref=e71]
            - button "Open workspace panel" [ref=e75]:
              - img [ref=e76]
          - generic [ref=e79]:
            - generic [ref=e82]:
              - generic [ref=e86]:
                - generic [ref=e88]:
                  - generic:
                    - generic:
                      - button "Scroll to latest message":
                        - img
                  - region "scrollable content" [ref=e90]:
                    - generic [ref=e92]:
                      - heading "Run the bounded command" [level=1] [ref=e95]
                      - button "More options" [ref=e97]:
                        - img [ref=e98]
                    - generic [ref=e100]:
                      - generic [ref=e107]:
                        - generic [ref=e109]: Run the bounded command
                        - generic:
                          - generic:
                            - generic: Build · gpt-5.6-sol
                            - generic: ·
                            - generic: 5:08 AM
                          - generic:
                            - button "Revert message":
                              - img
                          - generic:
                            - button "Copy message":
                              - img
                      - button "Running sleep 60; printf interrupted-command 0s" [ref=e118]:
                        - generic [ref=e119]:
                          - generic [ref=e120]:
                            - img [ref=e122]
                            - generic [ref=e126]:
                              - generic "Running" [ref=e128]:
                                - generic [ref=e129]:
                                  - generic [ref=e130]: Running
                                  - generic [ref=e131]: Running
                              - generic [ref=e134]: sleep 60; printf interrupted-command
                          - generic [ref=e135]: 0s
                          - img [ref=e138]
                      - generic [ref=e146]:
                        - paragraph [ref=e150]: QA_REPLAY_PROBE
                        - generic:
                          - generic:
                            - button "Copy response":
                              - img
                - generic [ref=e154]:
                  - generic [ref=e156]:
                    - textbox "Ask anything, / for commands, @ for context..." [ref=e157]
                    - generic: Ask anything, / for commands, @ for context...
                  - generic [ref=e158]:
                    - generic [ref=e159]:
                      - button "Add" [ref=e160]:
                        - img [ref=e161]
                      - button "Approve for me" [ref=e165]:
                        - img [ref=e166]
                        - generic [ref=e168]: Workspace write
                      - button "Select harness and model" [ref=e170]:
                        - img [ref=e172]
                        - generic [ref=e174]: GPT-5.5
                        - img [ref=e175]
                    - button "Type a message to get started" [disabled] [ref=e179]:
                      - img [ref=e180]
              - complementary "Session environment" [ref=e182]:
                - generic [ref=e183]:
                  - button "Open changes" [ref=e184]:
                    - img [ref=e185]
                  - button "Open files" [ref=e187]:
                    - img [ref=e188]
                  - button "Open processes" [ref=e190]:
                    - img [ref=e191]
                  - button "Expand Environment" [ref=e193]:
                    - img [ref=e194]
            - img [ref=e197]
  - generic:
    - region "Notifications (alt+T)":
      - list
```

# Test source

```ts
  873  |     await expect(row).toContainText("Running")
  874  |     await page.screenshot({ path: testInfo.outputPath("command-running.png") })
  875  |     mock.emit({ type: "message.part.updated", properties: { part } } as never, dir)
  876  |     mock.emit({ type: "message.updated", properties: { sessionID: sessionId, info: assistantInfo } } as never, dir)
  877  |     await expect(row).toContainText(/Failed|Interrupted/)
  878  |     await page.reload()
  879  |     await expectAssistantReplyVisible(page, "ack 1: matrix probe codex-app-server")
  880  |     await expect(row).toBeVisible()
  881  |     await page.screenshot({ path: testInfo.outputPath("interrupted-command-reloaded.png") })
  882  |     await expect(row).toContainText(/Failed|Interrupted/)
  883  |     await expect(row).not.toContainText("Running")
  884  |   })
  885  | 
  886  |   test("an interrupted Codex command stays interrupted when rail-return replay resends its start", async ({ page }, testInfo) => {
  887  |     // test.fixme(true, "a replayed runtime tool start overwrites the stored interrupted state and the row returns to Running")
  888  |     const dir = "/tmp/e2e-interrupted-replay"
  889  |     const sessionId = "ses_interrupted_replay"
  890  |     const otherId = "ses_interrupted_replay_other"
  891  |     const userId = "msg_interrupted_replay"
  892  |     const assistantId = `${userId}_r`
  893  |     const callId = "exec-interrupted-replay"
  894  |     const captured = JSON.parse(readFileSync(join(FIXTURES_DIR, "codex-interrupted-command.json"), "utf8"))
  895  |     // The stored part id is the client projection's `seqId` mint (`000000_<callID>`);
  896  |     // a replayed start for the same callID regenerates that id, which is how a
  897  |     // stale frame reaches the already-settled part.
  898  |     const part = {
  899  |       ...captured,
  900  |       id: `000000_${callId}`,
  901  |       callID: callId,
  902  |       sessionID: sessionId,
  903  |       messageID: assistantId,
  904  |     }
  905  |     const messages = [
  906  |       {
  907  |         info: {
  908  |           id: userId, sessionID: sessionId, role: "user",
  909  |           time: { created: captured.state.time.start - 2000 },
  910  |           agent: "build", model: { providerID: "codex", modelID: "gpt-5.6-sol" },
  911  |         },
  912  |         parts: [{ id: `prt_${userId}`, sessionID: sessionId, messageID: userId, type: "text", text: "Run the bounded command" }],
  913  |       },
  914  |       {
  915  |         info: {
  916  |           id: assistantId, sessionID: sessionId, role: "assistant", parentID: userId,
  917  |           time: { created: captured.state.time.start - 1000, completed: captured.state.time.end },
  918  |           modelID: "gpt-5.6-sol", providerID: "codex", mode: "auto", agent: "build",
  919  |           path: { cwd: dir, root: dir }, cost: 0,
  920  |           tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  921  |         },
  922  |         parts: [part],
  923  |       },
  924  |     ] as unknown as MockMessageRow[]
  925  |     const mock = await installMockRuntime(page, {
  926  |       dir, sessionId, projectId: PROJECT_ID, workspaceId: PROJECT_ID, harness: "codex-app-server",
  927  |       existingSession: { messages },
  928  |       otherSessions: [{ id: otherId, title: "Other session", prompt: "Other prompt", reply: "Other reply" }],
  929  |     })
  930  |     await seedOneProject(page, dir)
  931  |     await page.goto(`/${slug(dir)}/session/${sessionId}`)
  932  |     const row = page.locator(SELECTORS.toolPart(part.id))
  933  |     await expect(row).toBeVisible()
  934  |     await expect(row).toContainText(/Failed|Interrupted/)
  935  |     await page.screenshot({ path: testInfo.outputPath("interrupted-before-replay.png") })
  936  |     await (await expectRailRowVisible({ page, sessionId: otherId })).click()
  937  |     await expectAssistantReplyVisible(page, "Other reply", { spec: "core-harness-rendering-matrix", scenario: `interrupt-away-${testInfo.repeatEachIndex}` })
  938  |     await (await expectRailRowVisible({ page, sessionId })).click()
  939  |     // Reload first: the canonical refetch must finish before the replay lands,
  940  |     // or the arriving messages overwrite the stale frame back to terminal and
  941  |     // mask the defect — the original report showed Running AFTER the reload.
  942  |     const refetched = page.waitForResponse(response =>
  943  |       response.request().method() === "GET"
  944  |       && /\/session\/[^/]+\/message/.test(new URL(response.url()).pathname)
  945  |       && response.status() === 200)
  946  |     await page.reload()
  947  |     await refetched
  948  |     await expect(row).toBeVisible()
  949  |     await expect(row).toContainText(/Failed|Interrupted/)
  950  |     // The runtime stream replays the turn's start frames on reattach: the
  951  |     // terminal frame is what the stored part already carries, and a fresh
  952  |     // projection has no memory of it.
  953  |     for (const payload of [
  954  |       {
  955  |         harness: "codex", threadId: sessionId, type: "tool-start",
  956  |         toolCallId: callId, toolName: "command", kind: "command_execution",
  957  |         display: { kind: "command_execution", intent: "shell", command: captured.state.input.command, description: captured.state.input.command },
  958  |       },
  959  |       { harness: "codex", threadId: sessionId, type: "tool-input", toolCallId: callId, input: captured.state.input },
  960  |       { harness: "codex", threadId: sessionId, type: "text-delta", delta: "QA_REPLAY_PROBE" },
  961  |     ]) {
  962  |       mock.emitRuntime({ directory: dir, sessionId, agentSessionId: sessionId, assistantMessageId: assistantId, payload: payload as never })
  963  |     }
  964  |     // The probe proves the replayed frames reached this session's conversation —
  965  |     // without it a silent channel would read as "no resurrection".
  966  |     await expect(page.getByText("QA_REPLAY_PROBE", { exact: false })).toBeVisible({ timeout: 10_000 })
  967  |     await page.screenshot({ path: testInfo.outputPath("interrupted-after-replay.png") })
  968  |     const sawRunning = await expect
  969  |       .poll(async () => (await row.textContent())?.includes("Running"), { timeout: 5_000 })
  970  |       .toBe(true)
  971  |       .then(() => true)
  972  |       .catch(() => false)
> 973  |     expect(sawRunning, "the stored interrupted command returned to Running after its start frames replayed").toBe(false)
       |                                                                                                              ^ Error: the stored interrupted command returned to Running after its start frames replayed
  974  |   })
  975  | 
  976  |   test("renderer-only canonical fixture — session.diff routes to the diff cache, never a phantom message row", async ({ page }) => {
  977  |     const { mock, dir, assistantId } = await primeHarness(page, "opencode")
  978  |     const content = page.locator(assistantContent())
  979  |     const before = await content.locator('[data-component="tool-part-wrapper"], [data-component="text-part"], [data-component="reasoning-part"]').count()
  980  | 
  981  |     const fixture = loadFixtureFile("opencode", assistantId) as { sessionDiff: Envelope }
  982  |     mock.emit(fixture.sessionDiff.payload as never, fixture.sessionDiff.directory || dir)
  983  | 
  984  |     await expect.poll(
  985  |       async () => content.locator('[data-component="tool-part-wrapper"], [data-component="text-part"], [data-component="reasoning-part"]').count(),
  986  |       { timeout: 20_000 },
  987  |     ).toBe(before)
  988  |     expect(nonBackgroundNoiseConsole(mock.requests.console.filter((line) => /error/i.test(line)))).toEqual([])
  989  |   })
  990  | 
  991  |   test("pi — shares the native rendering path (text renders)", async ({ page }) => {
  992  |     const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"pi")
  993  |     const trace = loadTrace("pi", assistantId)
  994  |     await replay(mock, dir, trace, assistantInfo)
  995  | 
  996  |     const content = page.locator(assistantContent())
  997  |     await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
  998  |   })
  999  | 
  1000 |   test("pi — one dedicated tool renderer (config.json subtitle)", async ({ page }) => {
  1001 |     const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"pi")
  1002 |     const trace = loadTrace("pi", assistantId)
  1003 |     await replay(mock, dir, trace, assistantInfo)
  1004 | 
  1005 |     const content = page.locator(assistantContent())
  1006 |     // Delivery anchor: the leading text lands (shared native path) before we unfold.
  1007 |     await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
  1008 |     await revealTurn(page)
  1009 | 
  1010 |     await expect(
  1011 |       content.locator('[data-slot="basic-tool-tool-subtitle"]', { hasText: "config.json" }).first(),
  1012 |     ).toBeVisible({ timeout: 45_000 })
  1013 |   })
  1014 | 
  1015 |   test("claude-acp — text dedup, Terminal->bash, read, todowrite hidden, unbound Task omitted", async ({ page }) => {
  1016 |     // The longest trace here; on a 2-core runner the replay alone crowds the 60s default.
  1017 |     test.slow()
  1018 |     const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"claude-acp")
  1019 |     const trace = loadTrace("claude-acp", assistantId)
  1020 |     await replay(mock, dir, trace, assistantInfo)
  1021 | 
  1022 |     const content = page.locator(assistantContent())
  1023 | 
  1024 |     // The fixture's two deltas concatenate once, with no re-appended prefix. The
  1025 |     // adapter turned the provider's cumulative snapshots into deltas before the trace
  1026 |     // was recorded, so this checks accumulation, not snapshot dedup. Also the delivery
  1027 |     // anchor: leading text renders while the turn is still folded.
  1028 |     await expect(content.getByText("Building the feature now.", { exact: true })).toBeVisible({ timeout: 45_000 })
  1029 |     await expect(content.getByText("Building the Building the", { exact: false })).toHaveCount(0)
  1030 | 
  1031 |     await revealTurn(page)
  1032 | 
  1033 |     // The ACP registry normalized Claude's raw "Terminal" title to `bash` before the
  1034 |     // trace was recorded, so this dispatches to the bash renderer. It is a lone work
  1035 |     // tool, hence a standalone row. Re-reveal inside the poll: a late re-render can
  1036 |     // re-collapse the fold after `revealTurn` returns and hide the row again.
  1037 |     await expect
  1038 |       .poll(
  1039 |         async () => {
  1040 |           const visible = await content.getByText("printf hi").isVisible().catch(() => false)
  1041 |           if (visible) return true
  1042 |           await revealTurn(page)
  1043 |           return content.getByText("printf hi").isVisible().catch(() => false)
  1044 |         },
  1045 |         { timeout: 30_000 },
  1046 |       )
  1047 |       .toBe(true)
  1048 | 
  1049 |     // Raw "Read File" was normalized to `read` upstream, so this reaches the dedicated
  1050 |     // read renderer.
  1051 |     await expect(content.locator('[data-slot="basic-tool-tool-subtitle"]', { hasText: "index.ts" })).toBeVisible()
  1052 | 
  1053 |     // A translated trace carries no host spawn edge, so no subagent surface renders. The
  1054 |     // subagents matrix below supplies that association.
  1055 |     await expect(content.getByText("Review the auth module")).toHaveCount(0)
  1056 | 
  1057 |     // "Update TODOs" never becomes a tool row.
  1058 |     await expect(content.getByText("Ship the fix")).toHaveCount(0)
  1059 |   })
  1060 | 
  1061 |   test("codex-acp — Permission fake tool routes to the dock (not a tool row); apply_patch resolves to edit; bash", async ({ page }) => {
  1062 |     const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"codex-acp")
  1063 |     const trace = loadTrace("codex-acp", assistantId)
  1064 |     await replay(mock, dir, trace, assistantInfo)
  1065 | 
  1066 |     // `permission.asked` drives the dock.
  1067 |     await expect(page.locator('[data-slot="permission-header-title"]')).toBeVisible({ timeout: 45_000 })
  1068 |     const content = page.locator(assistantContent())
  1069 | 
  1070 |     // apply_patch->edit and bash are consecutive work tools, so they share one group.
  1071 |     await expect(content.locator('[data-component="work-group-trigger"]')).toBeVisible({ timeout: 45_000 })
  1072 |     await revealTurn(page)
  1073 | 
```
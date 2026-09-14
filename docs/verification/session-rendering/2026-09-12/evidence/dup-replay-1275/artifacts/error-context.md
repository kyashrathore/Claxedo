# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: playwright/core-harness-rendering-matrix.spec.ts >> core harness rendering matrix @core >> a settled reply does not re-render its streamed text when the turn's deltas replay
- Location: e2e/playwright/core-harness-rendering-matrix.spec.ts:976:3

# Error details

```
Error: the settled reply's streamed text rendered more than once after its deltas replayed

expect(received).toBe(expected) // Object.is equality

Expected: 1
Received: 2
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
                  - generic "mock-runtime · e2e-dup-replay" [ref=e36]: mock-runtime
                - generic [ref=e38]:
                  - generic [ref=e39]:
                    - button "Other session" [ref=e40]
                    - generic:
                      - generic: Other session
                    - generic [ref=e42]: now
                  - generic [ref=e43]:
                    - button "Show the exit list" [ref=e44]
                    - generic:
                      - generic: Show the exit list
                    - generic [ref=e45]:
                      - generic [ref=e46]: now
                      - button "Archive Show the exit list" [ref=e47] [cursor=pointer]:
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
                      - heading "Show the exit list" [level=1] [ref=e95]
                      - button "More options" [ref=e97]:
                        - img [ref=e98]
                    - generic [ref=e100]:
                      - generic [ref=e107]:
                        - generic [ref=e109]: Show the exit list
                        - generic:
                          - generic:
                            - generic: Build · gpt-5.6-sol
                            - generic: ·
                            - generic: 1:57 PM
                          - generic:
                            - button "Revert message":
                              - img
                          - generic:
                            - button "Copy message":
                              - img
                      - paragraph [ref=e120]: QA_DUP_REPLAY the two-item exit list renders once
                      - generic [ref=e127]:
                        - paragraph [ref=e131]: QA_DUP_REPLAY the two-item exit list renders once
                        - generic:
                          - generic:
                            - button "Copy response":
                              - img
                          - generic: Build · gpt-5.6-sol · 2s
                - generic [ref=e135]:
                  - generic [ref=e137]:
                    - textbox "Ask anything, / for commands, @ for context..." [ref=e138]
                    - generic: Ask anything, / for commands, @ for context...
                  - generic [ref=e139]:
                    - generic [ref=e140]:
                      - button "Add" [ref=e141]:
                        - img [ref=e142]
                      - button "Approve for me" [ref=e146]:
                        - img [ref=e147]
                        - generic [ref=e149]: Workspace write
                      - button "Select harness and model" [ref=e151]:
                        - img [ref=e153]
                        - generic [ref=e155]: GPT-5.5
                        - img [ref=e156]
                    - button "Type a message to get started" [disabled] [ref=e160]:
                      - img [ref=e161]
              - complementary "Session environment" [ref=e163]:
                - generic [ref=e164]:
                  - button "Open changes" [ref=e165]:
                    - img [ref=e166]
                  - button "Open files" [ref=e168]:
                    - img [ref=e169]
                  - button "Open processes" [ref=e171]:
                    - img [ref=e172]
                  - button "Expand Environment" [ref=e174]:
                    - img [ref=e175]
            - img [ref=e178]
  - generic:
    - region "Notifications (alt+T)":
      - list
```

# Test source

```ts
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
  973  |     expect(sawRunning, "the stored interrupted command returned to Running after its start frames replayed").toBe(false)
  974  |   })
  975  | 
  976  |   test("a settled reply does not re-render its streamed text when the turn's deltas replay", async ({ page }, testInfo) => {
  977  |     // test.fixme(true, "a replayed runtime text-delta re-appends the stored reply under a fresh part id once the message announcement un-settles it")
  978  |     const dir = "/tmp/e2e-dup-replay"
  979  |     const sessionId = "ses_dup_replay"
  980  |     const otherId = "ses_dup_replay_other"
  981  |     const userId = "msg_dup_replay"
  982  |     const assistantId = `${userId}_r`
  983  |     const text = "QA_DUP_REPLAY the two-item exit list renders once"
  984  |     // The stored part carries the server's own part id (`prt_…`), not the
  985  |     // client projection's `000000_<msg>-text` mint — a replayed delta cannot
  986  |     // find it, so the projected part is appended as a SECOND copy.
  987  |     const messages = [
  988  |       {
  989  |         info: {
  990  |           id: userId, sessionID: sessionId, role: "user",
  991  |           time: { created: Date.now() - 10_000 },
  992  |           agent: "build", model: { providerID: "codex", modelID: "gpt-5.6-sol" },
  993  |         },
  994  |         parts: [{ id: `prt_${userId}`, sessionID: sessionId, messageID: userId, type: "text", text: "Show the exit list" }],
  995  |       },
  996  |       {
  997  |         info: {
  998  |           id: assistantId, sessionID: sessionId, role: "assistant", parentID: userId,
  999  |           time: { created: Date.now() - 9_000, completed: Date.now() - 8_000 },
  1000 |           modelID: "gpt-5.6-sol", providerID: "codex", mode: "auto", agent: "build",
  1001 |           path: { cwd: dir, root: dir }, cost: 0,
  1002 |           tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  1003 |         },
  1004 |         parts: [{ id: "prt_dup_stored", sessionID: sessionId, messageID: assistantId, type: "text", text }],
  1005 |       },
  1006 |     ] as unknown as MockMessageRow[]
  1007 |     const mock = await installMockRuntime(page, {
  1008 |       dir, sessionId, projectId: PROJECT_ID, workspaceId: PROJECT_ID, harness: "codex-app-server",
  1009 |       existingSession: { messages },
  1010 |       otherSessions: [{ id: otherId, title: "Other session", prompt: "Other prompt", reply: "Other reply" }],
  1011 |     })
  1012 |     await seedOneProject(page, dir)
  1013 |     await page.goto(`/${slug(dir)}/session/${sessionId}`)
  1014 |     await expectAssistantReplyVisible(page, text, { spec: "core-harness-rendering-matrix", scenario: `dup-before-${testInfo.repeatEachIndex}` })
  1015 |     await (await expectRailRowVisible({ page, sessionId: otherId })).click()
  1016 |     await expectAssistantReplyVisible(page, "Other reply", { spec: "core-harness-rendering-matrix", scenario: `dup-away-${testInfo.repeatEachIndex}` })
  1017 |     await (await expectRailRowVisible({ page, sessionId })).click()
  1018 |     // The runtime stream replays the finished turn's deltas on reattach while
  1019 |     // the canonical messages fetch is still in flight: the projection cache was
  1020 |     // evicted at finish, so each frame is fresh state — the first announces
  1021 |     // message.updated (dropping time.completed off the stored envelope) and
  1022 |     // mints a fresh text part (`000000_<msg>-text`) that the REST merge then
  1023 |     // keeps alongside the stored part (`prt_…`). Emitting before reload lands
  1024 |     // the frames in the bus log; the delayed fetch keeps the store empty while
  1025 |     // the reattaching consumer drains them.
  1026 |     await page.route("**/session/*/message**", async (route) => {
  1027 |       await new Promise((resolve) => setTimeout(resolve, 800))
  1028 |       await route.fallback()
  1029 |     })
  1030 |     for (const delta of ["QA_DUP_REPLAY the two-item ", "exit list renders once"]) {
  1031 |       mock.emitRuntime({ directory: dir, sessionId, agentSessionId: sessionId, assistantMessageId: assistantId, payload: { harness: "codex", threadId: sessionId, type: "text-delta", delta } as never })
  1032 |     }
  1033 |     const refetched = page.waitForResponse(response =>
  1034 |       response.request().method() === "GET"
  1035 |       && /\/session\/[^/]+\/message/.test(new URL(response.url()).pathname)
  1036 |       && response.status() === 200)
  1037 |     await page.reload()
  1038 |     await refetched
  1039 |     await expectAssistantReplyVisible(page, text, { spec: "core-harness-rendering-matrix", scenario: `dup-restored-${testInfo.repeatEachIndex}` })
  1040 |     // The merge order may flip with the fetch landing mid-replay — sample the
  1041 |     // count across a window rather than once at the end.
  1042 |     let maxCopies = 0
  1043 |     await expect
  1044 |       .poll(async () => {
  1045 |         const n = await page.getByText("QA_DUP_REPLAY", { exact: false }).count()
  1046 |         maxCopies = Math.max(maxCopies, n)
  1047 |         return n
  1048 |       }, { timeout: 10_000 })
  1049 |       .toBeGreaterThanOrEqual(1)
  1050 |     await page.screenshot({ path: testInfo.outputPath("dup-after-replay.png") })
> 1051 |     expect(maxCopies, "the settled reply's streamed text rendered more than once after its deltas replayed").toBe(1)
       |                                                                                                              ^ Error: the settled reply's streamed text rendered more than once after its deltas replayed
  1052 |   })
  1053 | 
  1054 |   test("renderer-only canonical fixture — session.diff routes to the diff cache, never a phantom message row", async ({ page }) => {
  1055 |     const { mock, dir, assistantId } = await primeHarness(page, "opencode")
  1056 |     const content = page.locator(assistantContent())
  1057 |     const before = await content.locator('[data-component="tool-part-wrapper"], [data-component="text-part"], [data-component="reasoning-part"]').count()
  1058 | 
  1059 |     const fixture = loadFixtureFile("opencode", assistantId) as { sessionDiff: Envelope }
  1060 |     mock.emit(fixture.sessionDiff.payload as never, fixture.sessionDiff.directory || dir)
  1061 | 
  1062 |     await expect.poll(
  1063 |       async () => content.locator('[data-component="tool-part-wrapper"], [data-component="text-part"], [data-component="reasoning-part"]').count(),
  1064 |       { timeout: 20_000 },
  1065 |     ).toBe(before)
  1066 |     expect(nonBackgroundNoiseConsole(mock.requests.console.filter((line) => /error/i.test(line)))).toEqual([])
  1067 |   })
  1068 | 
  1069 |   test("pi — shares the native rendering path (text renders)", async ({ page }) => {
  1070 |     const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"pi")
  1071 |     const trace = loadTrace("pi", assistantId)
  1072 |     await replay(mock, dir, trace, assistantInfo)
  1073 | 
  1074 |     const content = page.locator(assistantContent())
  1075 |     await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
  1076 |   })
  1077 | 
  1078 |   test("pi — one dedicated tool renderer (config.json subtitle)", async ({ page }) => {
  1079 |     const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"pi")
  1080 |     const trace = loadTrace("pi", assistantId)
  1081 |     await replay(mock, dir, trace, assistantInfo)
  1082 | 
  1083 |     const content = page.locator(assistantContent())
  1084 |     // Delivery anchor: the leading text lands (shared native path) before we unfold.
  1085 |     await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
  1086 |     await revealTurn(page)
  1087 | 
  1088 |     await expect(
  1089 |       content.locator('[data-slot="basic-tool-tool-subtitle"]', { hasText: "config.json" }).first(),
  1090 |     ).toBeVisible({ timeout: 45_000 })
  1091 |   })
  1092 | 
  1093 |   test("claude-acp — text dedup, Terminal->bash, read, todowrite hidden, unbound Task omitted", async ({ page }) => {
  1094 |     // The longest trace here; on a 2-core runner the replay alone crowds the 60s default.
  1095 |     test.slow()
  1096 |     const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"claude-acp")
  1097 |     const trace = loadTrace("claude-acp", assistantId)
  1098 |     await replay(mock, dir, trace, assistantInfo)
  1099 | 
  1100 |     const content = page.locator(assistantContent())
  1101 | 
  1102 |     // The fixture's two deltas concatenate once, with no re-appended prefix. The
  1103 |     // adapter turned the provider's cumulative snapshots into deltas before the trace
  1104 |     // was recorded, so this checks accumulation, not snapshot dedup. Also the delivery
  1105 |     // anchor: leading text renders while the turn is still folded.
  1106 |     await expect(content.getByText("Building the feature now.", { exact: true })).toBeVisible({ timeout: 45_000 })
  1107 |     await expect(content.getByText("Building the Building the", { exact: false })).toHaveCount(0)
  1108 | 
  1109 |     await revealTurn(page)
  1110 | 
  1111 |     // The ACP registry normalized Claude's raw "Terminal" title to `bash` before the
  1112 |     // trace was recorded, so this dispatches to the bash renderer. It is a lone work
  1113 |     // tool, hence a standalone row. Re-reveal inside the poll: a late re-render can
  1114 |     // re-collapse the fold after `revealTurn` returns and hide the row again.
  1115 |     await expect
  1116 |       .poll(
  1117 |         async () => {
  1118 |           const visible = await content.getByText("printf hi").isVisible().catch(() => false)
  1119 |           if (visible) return true
  1120 |           await revealTurn(page)
  1121 |           return content.getByText("printf hi").isVisible().catch(() => false)
  1122 |         },
  1123 |         { timeout: 30_000 },
  1124 |       )
  1125 |       .toBe(true)
  1126 | 
  1127 |     // Raw "Read File" was normalized to `read` upstream, so this reaches the dedicated
  1128 |     // read renderer.
  1129 |     await expect(content.locator('[data-slot="basic-tool-tool-subtitle"]', { hasText: "index.ts" })).toBeVisible()
  1130 | 
  1131 |     // A translated trace carries no host spawn edge, so no subagent surface renders. The
  1132 |     // subagents matrix below supplies that association.
  1133 |     await expect(content.getByText("Review the auth module")).toHaveCount(0)
  1134 | 
  1135 |     // "Update TODOs" never becomes a tool row.
  1136 |     await expect(content.getByText("Ship the fix")).toHaveCount(0)
  1137 |   })
  1138 | 
  1139 |   test("codex-acp — Permission fake tool routes to the dock (not a tool row); apply_patch resolves to edit; bash", async ({ page }) => {
  1140 |     const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"codex-acp")
  1141 |     const trace = loadTrace("codex-acp", assistantId)
  1142 |     await replay(mock, dir, trace, assistantInfo)
  1143 | 
  1144 |     // `permission.asked` drives the dock.
  1145 |     await expect(page.locator('[data-slot="permission-header-title"]')).toBeVisible({ timeout: 45_000 })
  1146 |     const content = page.locator(assistantContent())
  1147 | 
  1148 |     // apply_patch->edit and bash are consecutive work tools, so they share one group.
  1149 |     await expect(content.locator('[data-component="work-group-trigger"]')).toBeVisible({ timeout: 45_000 })
  1150 |     await revealTurn(page)
  1151 | 
```
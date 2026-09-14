# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: playwright/core-busy-abort-errors.spec.ts >> core busy / abort / errors @core >> Thinking stays with the new prompt while the previous turn's completion envelope is in flight
- Location: e2e/playwright/core-busy-abort-errors.spec.ts:232:3

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  -   1
+ Received  + 497

- Array []
+ Array [
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+   "ses_core_busy_abort_errors_prev",
+ ]
```

# Page snapshot

```yaml
- generic [ref=e1]:
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
                  - generic "mock-runtime · e2e-core-busy-abort-errors" [ref=e36]: mock-runtime
                - generic [ref=e39]:
                  - button "previous prompt" [ref=e40]
                  - generic:
                    - generic: previous prompt
                  - generic [ref=e42]: now
          - button "Test User" [ref=e45]:
            - generic [ref=e46]: T
            - generic [ref=e47]: Test User
            - img [ref=e48]
      - main [ref=e52]:
        - generic [ref=e53]:
          - generic [ref=e55]:
            - generic [ref=e56]:
              - button "New Session" [ref=e58]:
                - img [ref=e59]
              - button "New Terminal" [ref=e62]:
                - img [ref=e63]
            - button "Open workspace panel" [ref=e67]:
              - img [ref=e68]
          - generic [ref=e71]:
            - generic [ref=e74]:
              - generic [ref=e78]:
                - generic [ref=e80]:
                  - generic:
                    - generic:
                      - button "Scroll to latest message":
                        - img
                  - region "scrollable content" [ref=e82]:
                    - generic [ref=e84]:
                      - heading "previous prompt" [level=1] [ref=e87]
                      - button "More options" [ref=e89]:
                        - img [ref=e90]
                    - generic [ref=e92]:
                      - generic [ref=e99]:
                        - generic [ref=e101]: previous prompt
                        - generic:
                          - generic:
                            - generic: Build · gpt-5
                            - generic: ·
                            - generic: 3:43 AM
                          - generic:
                            - button "Revert message":
                              - img
                          - generic:
                            - button "Copy message":
                              - img
                      - generic [ref=e108]:
                        - paragraph [ref=e112]: previous completed reply
                        - generic:
                          - generic:
                            - button "Copy response":
                              - img
                          - generic: Build · gpt-5
                      - generic [ref=e122]:
                        - generic [ref=e124]: Thinking ownership probe
                        - generic:
                          - generic:
                            - generic: Build · gpt-5
                            - generic: ·
                            - generic: 1:00 PM
                          - generic:
                            - button "Revert message":
                              - img
                          - generic:
                            - button "Copy message":
                              - img
                      - generic [ref=e131]:
                        - paragraph [ref=e135]: "ack 1: Thinking ownership probe"
                        - generic:
                          - generic:
                            - button "Copy response":
                              - img
                          - generic: Build · gpt-5 · 8s
                - generic [ref=e137]:
                  - status [ref=e138]:
                    - img [ref=e139]
                    - text: Reconnecting…
                  - generic [ref=e157]:
                    - generic [ref=e159]:
                      - textbox "Ask anything, / for commands, @ for context..." [active] [ref=e160]
                      - generic: Ask anything, / for commands, @ for context...
                    - generic [ref=e161]:
                      - generic [ref=e162]:
                        - button "Add" [ref=e163]:
                          - img [ref=e164]
                        - button "Approve for me" [ref=e168]:
                          - img [ref=e169]
                          - generic [ref=e171]: Workspace write
                        - button "Select harness and model" [ref=e173]:
                          - img [ref=e175]
                          - generic [ref=e177]: GPT-5
                          - img [ref=e178]
                      - button "Type a message to get started" [disabled] [ref=e182]:
                        - img [ref=e183]
              - complementary "Session environment" [ref=e185]:
                - generic [ref=e186]:
                  - button "Open changes" [ref=e187]:
                    - img [ref=e188]
                  - button "Open files" [ref=e190]:
                    - img [ref=e191]
                  - button "Open processes" [ref=e193]:
                    - img [ref=e194]
                  - button "Expand Environment" [ref=e196]:
                    - img [ref=e197]
            - img [ref=e200]
  - generic:
    - region "Notifications (alt+T)":
      - list
  - generic:
    - generic:
      - tooltip "Type a message to get started":
        - generic:
          - generic: Type a message to get started
```

# Test source

```ts
  189 |       await expectAssistantReplyVisible(page, "ack 1: Thinking continuity probe")
  190 |     })
  191 |     expect(mock.requests.promptCount).toBe(1)
  192 |     const messageID = mock.requests.promptBodies[0]?.messageID
  193 |     expect(messageID).toBeTruthy()
  194 |     const thinking = (sample: typeof samples[number]) => sample.elements.some(element =>
  195 |       element.messageID === messageID && element.slot === "session-turn-thinking" && element.painted)
  196 |     const firstThinking = samples.findIndex(thinking)
  197 |     const firstReply = samples.findIndex(sample => sample.elements.some(element =>
  198 |       element.messageID === messageID && element.slot === "session-turn-assistant-content" && element.hasText && element.painted))
  199 |     await writeFile(testInfo.outputPath("thinking-continuity.json"), JSON.stringify({ messageID, firstThinking, firstReply, eventWebSocketConnections: mock.requests.eventWebSocketConnections, samples }, null, 2))
  200 |     expect(mock.requests.eventWebSocketConnections).toBeGreaterThan(0)
  201 |     expect(firstThinking).toBeGreaterThanOrEqual(0)
  202 |     expect(firstReply).toBeGreaterThan(firstThinking)
  203 |     expect(samples.slice(firstThinking, firstReply).filter(sample => !thinking(sample))).toEqual([])
  204 |   })
  205 | 
  206 |   test("Thinking belongs to the new prompt throughout a follow-up send", async ({ page }, testInfo) => {
  207 |     const mock = await installMockRuntime(page, {
  208 |       dir: DIR, sessionId: SESSION_ID, harness: "codex-app-server",
  209 |       harnessModels: { "codex-app-server": [{ id: "gpt-5", name: "GPT-5" }] },
  210 |       existingSession: { prompt: "previous prompt", reply: "previous completed reply" },
  211 |       timingsMs: { busy: 60, pending: 150, delta: 2000, completed: 300, idle: 150 },
  212 |     })
  213 |     await seedOneProject(page, DIR)
  214 |     await page.goto(`/${slug(DIR)}/session/${SESSION_ID}`)
  215 |     await expectAssistantReplyVisible(page, "previous completed reply")
  216 |     const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  217 |     const samples = await sampleElementDuringAction(page, SELECTORS.thinkingRow, async () => {
  218 |       await ensureComposerModelSelected(page)
  219 |       await input.fill("Thinking ownership probe")
  220 |       await page.locator(SELECTORS.submitControl).last().click()
  221 |       await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible()
  222 |       await expectAssistantReplyVisible(page, "ack 1: Thinking ownership probe")
  223 |     })
  224 |     expect(mock.requests.promptCount).toBe(1)
  225 |     const messageID = mock.requests.promptBodies[0]?.messageID
  226 |     expect(messageID).toBeTruthy()
  227 |     await writeFile(testInfo.outputPath("thinking-ownership.json"), JSON.stringify({ messageID, samples }, null, 2))
  228 |     expect(samples.some(sample => sample.visible > 0)).toBe(true)
  229 |     expect(samples.flatMap(sample => sample.messageIDs).filter(owner => owner !== messageID)).toEqual([])
  230 |   })
  231 | 
  232 |   test("Thinking stays with the new prompt while the previous turn's completion envelope is in flight", async ({ page }, testInfo) => {
  233 |     // test.fixme(true, "the prior turn's un-completed assistant wins the pending anchor, so Thinking paints beneath its reply")
  234 |     const prevUserId = `${SESSION_ID}_prev`
  235 |     const prevAssistantId = `${prevUserId}_r`
  236 |     const created = 1_700_000_000_000
  237 |     const messages = [
  238 |       {
  239 |         info: {
  240 |           id: prevUserId, sessionID: SESSION_ID, role: "user",
  241 |           time: { created },
  242 |           agent: "build", model: { providerID: "codex", modelID: "gpt-5" },
  243 |         },
  244 |         parts: [{ id: `prt_${prevUserId}`, sessionID: SESSION_ID, messageID: prevUserId, type: "text", text: "previous prompt" }],
  245 |       },
  246 |       {
  247 |         // Reply parts are painted, but the envelope completion has not landed:
  248 |         // the producer's `message.updated` (with time.completed) is still in
  249 |         // flight — the state the original send observed at 0.57–1.05s.
  250 |         info: {
  251 |           id: prevAssistantId, sessionID: SESSION_ID, role: "assistant", parentID: prevUserId,
  252 |           time: { created: created + 1000 },
  253 |           modelID: "gpt-5", providerID: "codex", mode: "auto", agent: "build",
  254 |           path: { cwd: DIR, root: DIR }, cost: 0,
  255 |           tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  256 |         },
  257 |         parts: [{ id: `prt_${prevAssistantId}`, sessionID: SESSION_ID, messageID: prevAssistantId, type: "text", text: "previous completed reply" }],
  258 |       },
  259 |     ]
  260 |     const mock = await installMockRuntime(page, {
  261 |       dir: DIR, sessionId: SESSION_ID, harness: "codex-app-server",
  262 |       harnessModels: { "codex-app-server": [{ id: "gpt-5", name: "GPT-5" }] },
  263 |       existingSession: { messages: messages as MockMessageRow[] },
  264 |       sessionStatuses: { [SESSION_ID]: { type: "busy" } },
  265 |       // The defect window is busy-before-pending: the new turn's assistant
  266 |       // envelope has not announced itself, so the un-completed previous
  267 |       // assistant still owns the Thinking anchor.
  268 |       timingsMs: { busy: 60, pending: 4000, delta: 4000, completed: 300, idle: 150 },
  269 |     })
  270 |     await seedOneProject(page, DIR)
  271 |     await page.goto(`/${slug(DIR)}/session/${SESSION_ID}`)
  272 |     await expectAssistantReplyVisible(page, "previous completed reply")
  273 |     const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  274 |     let submitAt = 0
  275 |     const samples = await sampleElementDuringAction(page, SELECTORS.thinkingRow, async () => {
  276 |       await ensureComposerModelSelected(page)
  277 |       await input.fill("Thinking ownership probe")
  278 |       await page.locator(SELECTORS.submitControl).last().click()
  279 |       submitAt = await page.evaluate(() => performance.now())
  280 |       await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible()
  281 |       await expectAssistantReplyVisible(page, "ack 1: Thinking ownership probe")
  282 |     })
  283 |     expect(mock.requests.promptCount).toBe(1)
  284 |     const messageID = mock.requests.promptBodies[0]?.messageID
  285 |     expect(messageID).toBeTruthy()
  286 |     await writeFile(testInfo.outputPath("thinking-ownership-tail.json"), JSON.stringify({ messageID, prevUserId, submitAt, samples }, null, 2))
  287 |     const afterSubmit = samples.filter(sample => sample.time >= submitAt)
  288 |     expect(afterSubmit.some(sample => sample.messageIDs.includes(messageID ?? null))).toBe(true)
> 289 |     expect(afterSubmit.flatMap(sample => sample.messageIDs).filter(owner => owner !== messageID)).toEqual([])
      |                                                                                                   ^ Error: expect(received).toEqual(expected) // deep equality
  290 |   })
  291 | 
  292 |   test("Thinking renders while busy, then gives way to the visible reply", async ({ page }) => {
  293 |     const mock = await installMockRuntime(page, {
  294 |       dir: DIR,
  295 |       sessionId: SESSION_ID,
  296 |       harnessModels: PIN_MODELS,
  297 |       // Busy ends when the first assistant content lands (~busy + pending + delta/2), so
  298 |       // a wide delta leaves room for the busy assertions under contention.
  299 |       timingsMs: { busy: 60, pending: 150, delta: 12_000, completed: 300, idle: 150 },
  300 |     })
  301 |     await neutralizeStatusPoll(page)
  302 |     await seedOneProject(page, DIR)
  303 |     const input = await openDraftPrompt(page, DIR)
  304 | 
  305 |     const promptText = "busy abort errors turn one thinking"
  306 |     await sendPrompt(page, input, promptText)
  307 | 
  308 |     await expect(page.locator(SELECTORS.thinkingRow), "Thinking row never appeared while busy").toBeVisible({
  309 |       timeout: 20_000,
  310 |     })
  311 |     await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
  312 | 
  313 |     await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
  314 |     await expect(page.locator(SELECTORS.thinkingRow)).toHaveCount(0)
  315 |     expect(mock.requests.promptCount).toBe(1)
  316 |   })
  317 | 
  318 |   test("stale-busy: completed reply stays visible and status reconciles without user action", async ({
  319 |     page,
  320 |   }) => {
  321 |     const mock = await installMockRuntime(page, {
  322 |       dir: DIR,
  323 |       sessionId: SESSION_ID,
  324 |       harnessModels: PIN_MODELS,
  325 |       staleBusy: true,
  326 |       timingsMs: { busy: 40, pending: 80, delta: 300, completed: 80, idle: 30 },
  327 |     })
  328 |     await seedOneProject(page, DIR)
  329 |     const input = await openDraftPrompt(page, DIR)
  330 | 
  331 |     const promptText = "stale busy regression reply must stay visible"
  332 |     await sendPrompt(page, input, promptText)
  333 | 
  334 |     await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
  335 |     expect(mock.requests.promptCount).toBe(1)
  336 |   })
  337 | 
  338 |   test("Stop click aborts the turn and status reconciles optimistically before the network responds", async ({
  339 |     page,
  340 |   }) => {
  341 |     // The abort response is held until `releaseAbort()`, so ready-before-response is under test.
  342 |     const mock = await installMockRuntime(page, {
  343 |       dir: DIR,
  344 |       sessionId: SESSION_ID,
  345 |       harnessModels: PIN_MODELS,
  346 |       holdAbort: true,
  347 |     })
  348 |     const promptState = await silencePromptAsync(page)
  349 |     await neutralizeStatusPoll(page)
  350 |     await seedOneProject(page, DIR)
  351 |     const input = await openDraftPrompt(page, DIR)
  352 | 
  353 |     await sendPrompt(page, input, "abort this turn please")
  354 |     await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible({ timeout: 20_000 })
  355 |     await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
  356 |     await waitForDispatchReceived(promptState)
  357 | 
  358 |     await submitIcon(page).click()
  359 | 
  360 |     // The abort has reached the network and its response is still held, so only the
  361 |     // optimistic idle write can have moved the control.
  362 |     await expect.poll(() => mock.requests.abortCount, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
  363 |     await expect(
  364 |       submitIcon(page),
  365 |       "submit control did not return to ready while the abort response was still held open",
  366 |     ).not.toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
  367 |     expect(promptState.count).toBe(1)
  368 | 
  369 |     // Release the held response so teardown is clean.
  370 |     mock.releaseAbort()
  371 |   })
  372 | 
  373 |   test("Stop shows the canonical cancelled-turn outcome without reloading", async ({ page }, testInfo) => {
  374 |     test.fixme(true, "OpenCode Stop omits the cancelled-turn explanation until the session reloads")
  375 |     const mock = await installMockRuntime(page, {
  376 |       dir: DIR, sessionId: SESSION_ID, harnessModels: PIN_MODELS,
  377 |       existingSession: { prompt: "previous prompt", reply: "previous completed reply" },
  378 |       holdTurn: true, messageRefreshOnly: { responseDelayMs: 0 },
  379 |     })
  380 |     await seedOneProject(page, DIR)
  381 |     await page.goto(`/${slug(DIR)}/session/${SESSION_ID}`)
  382 |     await expectAssistantReplyVisible(page, "previous completed reply")
  383 |     await ensureComposerModelSelected(page)
  384 |     const pending = page.waitForResponse(async response => {
  385 |       if (!response.url().includes(`/session/${SESSION_ID}/message?`) || response.status() !== 200) return false
  386 |       const body = await response.json()
  387 |       return body.messages.some((row: { info: { id: string; role: string; time: { completed?: number } } }) =>
  388 |         row.info.id === mock.requests.promptBodies[0]?.assistantID && row.info.role === "assistant" && !row.info.time.completed)
  389 |     })
```
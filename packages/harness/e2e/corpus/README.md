# Wire corpus

Run one passing flow by its file basename, without `.flow.ts`. The corpus runner refuses variants listed in `../flows/expected-red.json` because their wire behavior changes when their defects are fixed.

```sh
/Users/yashvardhansingh/test/opencode-harness-lanes/_control/isolated-test.sh "$PWD" env CLAXEDO_E2E_PORT_RANGE=47100-47199 CLAXEDO_E2E_CORPUS=record bun packages/harness/e2e/harness/run-corpus-flow.ts H0-smoke
/Users/yashvardhansingh/test/opencode-harness-lanes/_control/isolated-test.sh "$PWD" env CLAXEDO_E2E_PORT_RANGE=47100-47199 CLAXEDO_E2E_CORPUS=compare bun packages/harness/e2e/harness/run-corpus-flow.ts H0-smoke
```

The recording contains HTTP status and body for flow readbacks and control replies, plus ordered live SSE frames. IDs use stable placeholders across channels. Time, temporary paths, process IDs and leased ports are normalized. `state` and `phase` retain their values.

`CLAXEDO_E2E_CORPUS_FAULT=rename-frame-field` changes a frame field in the comparison snapshot to prove the diff fails. The flow itself still receives the original frame.

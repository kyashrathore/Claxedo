#!/bin/sh
set -eu

apk add --no-cache curl jq >/dev/null

read_body='{"userId":"user_live_relay","orgId":"org_live_relay","projectId":"project_live_relay","localWorkspaceId":"local_ws","cloudWorkspaceId":"cloud_ws","sessionId":"session_live_relay","documentId":"document_live_relay","operation":"read"}'
read_json=$(curl --fail-with-body --silent --show-error --max-time 30 -X POST "$BASE$ENDPOINT" \
  -H "authorization: Bearer $RAT" \
  -H "x-claxedo-document-capability: $READ_CAP" \
  -H 'x-opencode-directory: workspace:local_ws' \
  -H 'content-type: application/json' \
  --data "$read_body")
version=$(printf '%s' "$read_json" | jq -r .read.version)
test "$(printf '%s' "$read_json" | jq -r .read.markdown)" = "before cloud VM relay"

markdown='after cloud VM relay CAS'
write_body=$(jq -nc \
  --arg markdown "$markdown
" \
  --arg expectedVersion "$version" \
  '{userId:"user_live_relay",orgId:"org_live_relay",projectId:"project_live_relay",localWorkspaceId:"local_ws",cloudWorkspaceId:"cloud_ws",sessionId:"session_live_relay",documentId:"document_live_relay",operation:"write",markdown:$markdown,expectedVersion:$expectedVersion}')
write_json=$(curl --fail-with-body --silent --show-error --max-time 30 -X POST "$BASE$ENDPOINT" \
  -H "authorization: Bearer $RAT" \
  -H "x-claxedo-document-capability: $WRITE_CAP" \
  -H 'x-opencode-directory: workspace:local_ws' \
  -H 'content-type: application/json' \
  --data "$write_body")
written_version=$(printf '%s' "$write_json" | jq -r .version)
test "$written_version" != "$version"

stale_body=$(jq -nc \
  --arg expectedVersion "$version" \
  '{userId:"user_live_relay",orgId:"org_live_relay",projectId:"project_live_relay",localWorkspaceId:"local_ws",cloudWorkspaceId:"cloud_ws",sessionId:"session_live_relay",documentId:"document_live_relay",operation:"write",markdown:"stale cloud VM writer\n",expectedVersion:$expectedVersion}')
stale_status=$(curl --silent --show-error --max-time 30 -o /tmp/stale.json -w '%{http_code}' -X POST "$BASE$ENDPOINT" \
  -H "authorization: Bearer $RAT" \
  -H "x-claxedo-document-capability: $STALE_CAP" \
  -H 'x-opencode-directory: workspace:local_ws' \
  -H 'content-type: application/json' \
  --data "$stale_body")
test "$stale_status" = "409"

jq -nc \
  --arg machine "$HOSTNAME" \
  --arg region "${FLY_REGION:-unknown}" \
  --arg read_markdown "$(printf '%s' "$read_json" | jq -r .read.markdown)" \
  --arg written_version "$written_version" \
  --arg stale_status "$stale_status" \
  '{cloud_vm:$machine,region:$region,read_markdown:$read_markdown,write_version_advanced:true,stale_cas_status:($stale_status|tonumber)}'

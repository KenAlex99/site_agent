#!/usr/bin/env bash
set -Eeuo pipefail

project_dir=${SITE_AGENT_PROJECT_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
project_dir=$(readlink -f -- "$project_dir")
if [[ ! -f "$project_dir/main.mjs" || ! -f "$project_dir/.env" ]]; then
  printf 'SITE_AGENT_PROJECT_DIR is not a chart-dashboard runtime directory\n' >&2
  exit 2
fi
test_port=${SITE_AGENT_TEST_PORT:-4311}
base_url="http://127.0.0.1:${test_port}"
server_pid=''
tmp_dir=$(mktemp -d /tmp/aiops-site-agent-e2e.XXXXXX)

cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  local resolved
  resolved=$(readlink -f -- "$tmp_dir" 2>/dev/null || true)
  case "$resolved" in
    /tmp/aiops-site-agent-e2e.*) rm -rf -- "$resolved" ;;
    *) printf 'Refusing to remove unexpected temporary path: %s\n' "$resolved" >&2 ;;
  esac
}
trap cleanup EXIT

if ! [[ "$test_port" =~ ^[0-9]+$ ]] || (( test_port < 1024 || test_port > 65535 )); then
  printf 'SITE_AGENT_TEST_PORT must be between 1024 and 65535\n' >&2
  exit 2
fi
if ss -H -ltn "sport = :${test_port}" | grep -q .; then
  printf 'Test port %s is already in use\n' "$test_port" >&2
  exit 2
fi
for command in node curl jq ss; do
  command -v "$command" >/dev/null || { printf 'Missing command: %s\n' "$command" >&2; exit 2; }
done

agent_token=$(tr -d '-' </proc/sys/kernel/random/uuid)
viewer_token=$(tr -d '-' </proc/sys/kernel/random/uuid)
other_viewer_token=$(tr -d '-' </proc/sys/kernel/random/uuid)
agent_credentials=$(jq -cn --arg token "$agent_token" '[{token:$token,tenantId:"tenant-a",siteId:"site-hk",sourceId:"librenms-hk-01"}]')
viewer_credentials=$(jq -cn --arg a "$viewer_token" --arg b "$other_viewer_token" '[{token:$a,tenantIds:["tenant-a"]},{token:$b,tenantIds:["tenant-b"]}]')

(
  cd "$project_dir"
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
  export HOST=127.0.0.1 PORT="$test_port"
  export SITE_AGENT_CREDENTIALS_JSON="$agent_credentials"
  export PLATFORM_VIEWER_CREDENTIALS_JSON="$viewer_credentials"
  exec node main.mjs
) >"$tmp_dir/server.log" 2>&1 &
server_pid=$!

ready=false
for _ in {1..20}; do
  if curl -fsS --max-time 2 "$base_url/api/v1/monitoring/health" >"$tmp_dir/health.json" 2>/dev/null; then
    ready=true
    break
  fi
  sleep 0.25
done
if [[ "$ready" != true ]]; then
  printf 'Temporary server did not become ready\n' >&2
  sed -n '1,80p' "$tmp_dir/server.log" >&2
  exit 1
fi

observed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
payload=$(jq -cn --arg observedAt "$observed_at" '{
  schemaVersion:"1.0",batchId:"live-batch-0002",sequence:2,kind:"snapshot",observedAt:$observedAt,
  devices:[{localDeviceId:"5",name:"core-router",hostname:"core-router",ip:"192.168.110.1",status:"up"}],
  ports:[{localPortId:"9",localDeviceId:"5",name:"Gi0/1",description:"Uplink",status:"up",speedBps:1000000000,rxBps:80000,txBps:40000}]
}')

assert_code() {
  local label=$1 expected=$2 actual=$3
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL %-34s expected=%s actual=%s\n' "$label" "$expected" "$actual" >&2
    return 1
  fi
  printf 'PASS %-34s HTTP %s\n' "$label" "$actual"
}

code=$(curl -sS --max-time 10 -o "$tmp_dir/unauthorized.json" -w '%{http_code}' -H 'content-type: application/json' --data-binary "$payload" "$base_url/api/v1/site-agent/batches")
assert_code unauthorized_upload 401 "$code"

code=$(curl -sS --max-time 10 -o "$tmp_dir/accepted.json" -w '%{http_code}' -H 'content-type: application/json' -H "authorization: Bearer $agent_token" --data-binary "$payload" "$base_url/api/v1/site-agent/batches")
assert_code valid_snapshot 202 "$code"
jq -e '.accepted == true and .duplicate == false and .applied == true and .sourceId == "librenms-hk-01"' "$tmp_dir/accepted.json" >/dev/null

code=$(curl -sS --max-time 10 -o "$tmp_dir/duplicate.json" -w '%{http_code}' -H 'content-type: application/json' -H "authorization: Bearer $agent_token" --data-binary "$payload" "$base_url/api/v1/site-agent/batches")
assert_code duplicate_batch 200 "$code"
jq -e '.duplicate == true and .applied == true' "$tmp_dir/duplicate.json" >/dev/null

code=$(curl -sS --max-time 10 -o "$tmp_dir/sources.json" -w '%{http_code}' -H "authorization: Bearer $viewer_token" "$base_url/api/v1/cloud/monitoring/sources")
assert_code tenant_source_list 200 "$code"
jq -e '.items | length == 1 and .[0].tenantId == "tenant-a" and .[0].sourceId == "librenms-hk-01"' "$tmp_dir/sources.json" >/dev/null

code=$(curl -sS --max-time 10 -o "$tmp_dir/snapshot.json" -w '%{http_code}' -H "authorization: Bearer $viewer_token" "$base_url/api/v1/cloud/monitoring/sources/librenms-hk-01/snapshot")
assert_code tenant_snapshot 200 "$code"
jq -e '.tenantId == "tenant-a" and .devices[0].deviceKey == "librenms-hk-01/device/5" and .ports[0].portKey == "librenms-hk-01/port/9" and .freshness == "fresh"' "$tmp_dir/snapshot.json" >/dev/null
printf 'SNAPSHOT %s\n' "$(jq -c '{tenantId,siteId,sourceId,sequence,freshness,deviceCount:(.devices|length),portCount:(.ports|length)}' "$tmp_dir/snapshot.json")"

spoofed=$(jq -c '.tenantId="tenant-b"' <<<"$payload")
code=$(curl -sS --max-time 10 -o "$tmp_dir/spoofed.json" -w '%{http_code}' -H 'content-type: application/json' -H "authorization: Bearer $agent_token" --data-binary "$spoofed" "$base_url/api/v1/site-agent/batches")
assert_code spoofed_tenant 403 "$code"

code=$(curl -sS --max-time 10 -o "$tmp_dir/hidden.json" -w '%{http_code}' -H "authorization: Bearer $other_viewer_token" "$base_url/api/v1/cloud/monitoring/sources/librenms-hk-01/snapshot")
assert_code cross_tenant_hidden 404 "$code"

older=$(jq -c '.batchId="live-batch-older" | .sequence=1' <<<"$payload")
code=$(curl -sS --max-time 10 -o "$tmp_dir/older.json" -w '%{http_code}' -H 'content-type: application/json' -H "authorization: Bearer $agent_token" --data-binary "$older" "$base_url/api/v1/site-agent/batches")
assert_code out_of_order_batch 202 "$code"
jq -e '.applied == false and .outOfOrder == true' "$tmp_dir/older.json" >/dev/null

secret=$(jq -c '.batchId="live-batch-secret" | .sequence=3 | .devices[0].snmpCommunity="must-not-pass"' <<<"$payload")
code=$(curl -sS --max-time 10 -o "$tmp_dir/secret.json" -w '%{http_code}' -H 'content-type: application/json' -H "authorization: Bearer $agent_token" --data-binary "$secret" "$base_url/api/v1/site-agent/batches")
assert_code forbidden_secret_field 400 "$code"

code=$(curl -sS --max-time 10 -o "$tmp_dir/invalid-json.json" -w '%{http_code}' -H 'content-type: application/json' -H "authorization: Bearer $agent_token" --data-binary '{' "$base_url/api/v1/site-agent/batches")
assert_code invalid_json 400 "$code"

head -c 2097153 /dev/zero | tr '\000' x >"$tmp_dir/oversized.json"
code=$(curl -sS --max-time 15 -o "$tmp_dir/oversized-response.json" -w '%{http_code}' -H 'content-type: application/json' -H "authorization: Bearer $agent_token" --data-binary @"$tmp_dir/oversized.json" "$base_url/api/v1/site-agent/batches")
assert_code oversized_batch 413 "$code"

kill "$server_pid"
wait "$server_pid" 2>/dev/null || true
server_pid=''
if ss -H -ltn "sport = :${test_port}" | grep -q .; then
  printf 'FAIL temporary listener still active on %s\n' "$test_port" >&2
  exit 1
fi
printf 'PASS %-34s port %s closed\n' temporary_listener_cleanup "$test_port"

curl -fsS --max-time 10 http://127.0.0.1:4310/api/v1/monitoring/health >"$tmp_dir/existing-health.json"
curl -fsS --max-time 10 http://127.0.0.1:4310/api/v1/monitoring/devices >"$tmp_dir/existing-devices.json"
printf 'EXISTING_SERVICE %s\n' "$(jq -c --slurpfile devices "$tmp_dir/existing-devices.json" '{status:.status,provider:.provider.id,deviceCount:($devices[0].items|length)}' "$tmp_dir/existing-health.json")"
printf 'SITE_AGENT_E2E_OK\n'

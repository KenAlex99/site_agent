#!/usr/bin/env bash
set -Eeuo pipefail

project_dir=${SITE_AGENT_PROJECT_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
project_dir=$(readlink -f -- "$project_dir")
local_url=${SITE_AGENT_LOCAL_URL:-http://127.0.0.1:4310}
test_port=${SITE_AGENT_TEST_PORT:-4311}
cloud_url="http://127.0.0.1:${test_port}"
sequence=${SITE_AGENT_TEST_SEQUENCE:-2026090301}
server_pid=''
tmp_dir=$(mktemp -d /tmp/aiops-site-agent-collector.XXXXXX)

cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  local resolved
  resolved=$(readlink -f -- "$tmp_dir" 2>/dev/null || true)
  case "$resolved" in
    /tmp/aiops-site-agent-collector.*) rm -rf -- "$resolved" ;;
    *) printf 'Refusing to remove unexpected temporary path: %s\n' "$resolved" >&2 ;;
  esac
}
trap cleanup EXIT

if [[ ! -f "$project_dir/main.mjs" || ! -f "$project_dir/site-agent-once.mjs" || ! -f "$project_dir/.env" ]]; then
  printf 'SITE_AGENT_PROJECT_DIR is not a complete chart-dashboard runtime directory\n' >&2
  exit 2
fi
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

curl -fsS --max-time 15 "$local_url/api/v1/monitoring/health" >"$tmp_dir/local-health.json"
curl -fsS --max-time 15 "$local_url/api/v1/monitoring/devices" >"$tmp_dir/local-devices.json"
curl -fsS --max-time 15 "$local_url/api/v1/monitoring/ports?page=1&pageSize=200&status=all&sort=traffic&order=desc" >"$tmp_dir/local-ports.json"
expected_devices=$(jq -er '.items | length' "$tmp_dir/local-devices.json")
expected_ports=$(jq -er '.total' "$tmp_dir/local-ports.json")

agent_token=$(tr -d '-' </proc/sys/kernel/random/uuid)
viewer_token=$(tr -d '-' </proc/sys/kernel/random/uuid)
agent_credentials=$(jq -cn --arg token "$agent_token" '[{token:$token,tenantId:"tenant-a",siteId:"site-hk",sourceId:"librenms-hk-01"}]')
viewer_credentials=$(jq -cn --arg token "$viewer_token" '[{token:$token,tenantIds:["tenant-a"]}]')

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
for _ in {1..30}; do
  if curl -fsS --max-time 2 "$cloud_url/api/v1/monitoring/health" >"$tmp_dir/cloud-health.json" 2>/dev/null; then
    ready=true
    break
  fi
  sleep 0.25
done
if [[ "$ready" != true ]]; then
  printf 'Temporary cloud simulator did not become ready\n' >&2
  sed -n '1,80p' "$tmp_dir/server.log" >&2
  exit 1
fi

time_command=()
if [[ -x /usr/bin/time ]]; then time_command=(/usr/bin/time -v -o "$tmp_dir/agent-time.txt"); fi
SITE_AGENT_LOCAL_URL="$local_url" \
SITE_AGENT_CLOUD_URL="$cloud_url" \
SITE_AGENT_TOKEN="$agent_token" \
SITE_AGENT_SEQUENCE="$sequence" \
"${time_command[@]}" node "$project_dir/site-agent-once.mjs" >"$tmp_dir/agent-result.json"

jq -e --argjson devices "$expected_devices" --argjson ports "$expected_ports" --argjson sequence "$sequence" '
  .status == "ok" and .accepted == true and .applied == true and .duplicate == false and
  .sourceId == "librenms-hk-01" and .sequence == $sequence and
  .deviceCount == $devices and .portCount == $ports
' "$tmp_dir/agent-result.json" >/dev/null

curl -fsS --max-time 15 -H "authorization: Bearer $viewer_token" \
  "$cloud_url/api/v1/cloud/monitoring/sources/librenms-hk-01/snapshot" >"$tmp_dir/snapshot.json"
jq -e --argjson devices "$expected_devices" --argjson ports "$expected_ports" --argjson sequence "$sequence" '
  .tenantId == "tenant-a" and .siteId == "site-hk" and .sourceId == "librenms-hk-01" and
  .sequence == $sequence and .freshness == "fresh" and
  (.devices | length) == $devices and (.ports | length) == $ports and
  (all(.devices[]; .deviceKey == ("librenms-hk-01/device/" + .localDeviceId))) and
  (all(.ports[]; .portKey == ("librenms-hk-01/port/" + .localPortId))) and
  ([.devices[].localDeviceId] as $device_ids | all(.ports[]; .localDeviceId as $id | $device_ids | index($id)))
' "$tmp_dir/snapshot.json" >/dev/null

if grep -Fq -- "$agent_token" "$tmp_dir/agent-result.json" "$tmp_dir/snapshot.json" "$tmp_dir/server.log"; then
  printf 'Agent credential was exposed in output\n' >&2
  exit 1
fi

printf 'AGENT_RESULT %s\n' "$(jq -c '{status,sourceId,batchId,sequence,deviceCount,portCount}' "$tmp_dir/agent-result.json")"
printf 'CLOUD_SNAPSHOT %s\n' "$(jq -c '{tenantId,siteId,sourceId,sequence,freshness,deviceCount:(.devices|length),portCount:(.ports|length)}' "$tmp_dir/snapshot.json")"
if [[ -f "$tmp_dir/agent-time.txt" ]]; then
  grep -E 'Elapsed \(wall clock\)|Maximum resident set size' "$tmp_dir/agent-time.txt" \
    | sed 's/^[[:space:]]*/AGENT_RESOURCE /'
fi

kill "$server_pid"
wait "$server_pid" 2>/dev/null || true
server_pid=''
if ss -H -ltn "sport = :${test_port}" | grep -q .; then
  printf 'Temporary listener is still active on %s\n' "$test_port" >&2
  exit 1
fi
curl -fsS --max-time 15 "$local_url/api/v1/monitoring/health" >/dev/null
printf 'PASS temporary_listener_cleanup port=%s\n' "$test_port"
printf 'PASS existing_4310_health status=up\n'
printf 'SITE_AGENT_COLLECTOR_E2E_OK\n'

#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
node_bin=${NODE_BIN:-node}
cloud_port=${ALERT_SMOKE_CLOUD_PORT:-24310}
relay_port=${ALERT_SMOKE_RELAY_PORT:-24312}
alertmanager_port=${ALERT_SMOKE_ALERTMANAGER_PORT:-29093}
container_name="aiops-alertmanager-smoke-$$"
run_dir=$(mktemp -d /tmp/aiops-alert-smoke.XXXXXX)
cloud_pid=''
relay_pid=''

cleanup() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    echo '--- relay log (failure) ---' >&2
    tail -n 80 "$run_dir/relay.log" >&2 2>/dev/null || true
    echo '--- cloud log (failure) ---' >&2
    tail -n 80 "$run_dir/cloud.log" >&2 2>/dev/null || true
    echo '--- alertmanager log (failure) ---' >&2
    docker logs --tail 80 "$container_name" >&2 2>/dev/null || true
    echo '--- alertmanager active alerts (failure) ---' >&2
    cat "$run_dir/alertmanager-alerts.json" >&2 2>/dev/null || true
    echo '--- alertmanager status (failure) ---' >&2
    cat "$run_dir/alertmanager-status.json" >&2 2>/dev/null || true
    echo '--- relay health (failure) ---' >&2
    cat "$run_dir/relay-health.json" >&2 2>/dev/null || true
    echo '--- alertmanager notification metrics (failure) ---' >&2
    cat "$run_dir/alertmanager-notification-metrics.txt" >&2 2>/dev/null || true
    echo '--- cloud alert events (failure) ---' >&2
    cat "$run_dir/cloud-alert-events.json" >&2 2>/dev/null || true
    echo '--- relay dead letters (failure) ---' >&2
    find "$run_dir/queue/dead" -maxdepth 1 -type f -name '*.json' -print -exec cat {} \; >&2 2>/dev/null || true
  fi
  [[ -n "$relay_pid" ]] && kill "$relay_pid" 2>/dev/null || true
  [[ -n "$cloud_pid" ]] && kill "$cloud_pid" 2>/dev/null || true
  wait "$relay_pid" 2>/dev/null || true
  wait "$cloud_pid" 2>/dev/null || true
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  case "$run_dir" in /tmp/aiops-alert-smoke.*) rm -rf -- "$run_dir" ;; esac
  return "$status"
}
trap cleanup EXIT INT TERM

for command in "$node_bin" curl jq docker ss; do command -v "$command" >/dev/null; done
for port in "$cloud_port" "$relay_port" "$alertmanager_port"; do
  if ss -H -ltn "sport = :$port" | grep -q .; then
    echo "Smoke-test port $port is already in use" >&2
    exit 1
  fi
done

agent_token="agent-$(tr -d '-' </proc/sys/kernel/random/uuid)"
viewer_token="viewer-$(tr -d '-' </proc/sys/kernel/random/uuid)"
relay_token="relay-$(tr -d '-' </proc/sys/kernel/random/uuid)"
printf '%s\n' "$relay_token" >"$run_dir/relay.token"
printf '%s\n' "$agent_token" >"$run_dir/cloud.token"
chmod 600 "$run_dir/cloud.token"
chmod 644 "$run_dir/relay.token"
mkdir -p "$run_dir/queue"

cat >"$run_dir/alertmanager.yml" <<EOF
global:
  resolve_timeout: 30s
route:
  receiver: relay
  group_by: [alertname]
  group_wait: 1s
  group_interval: 1s
  repeat_interval: 30m
receivers:
  - name: relay
    webhook_configs:
      - url: http://127.0.0.1:${relay_port}/api/v1/alertmanager/webhook
        send_resolved: true
        http_config:
          authorization:
            type: Bearer
            credentials_file: /run/secrets/relay.token
EOF

start_cloud() {
  SITE_AGENT_CREDENTIALS_JSON=$(jq -cn --arg token "$agent_token" '[{token:$token,tenantId:"tenant-smoke",siteId:"site-smoke",sourceId:"librenms-smoke-01"}]') \
  PLATFORM_VIEWER_CREDENTIALS_JSON=$(jq -cn --arg token "$viewer_token" '[{token:$token,tenantIds:["tenant-smoke"]}]') \
  HOST=127.0.0.1 PORT="$cloud_port" LIBRENMS_URL=http://127.0.0.1:9 LIBRENMS_TOKEN='' \
    "$node_bin" "$project_root/main.mjs" >"$run_dir/cloud.log" 2>&1 &
  cloud_pid=$!
  wait_http "http://127.0.0.1:${cloud_port}/api/v1/monitoring/health"
}

wait_http() {
  local url=$1
  for _ in $(seq 1 60); do
    curl -fsS "$url" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  echo "Timed out waiting for $url" >&2
  return 1
}

wait_json() {
  local url=$1 filter=$2
  for _ in $(seq 1 120); do
    body=$(curl -fsS -H "Authorization: Bearer $viewer_token" "$url" 2>/dev/null || true)
    [[ -n "$body" ]] && jq -e "$filter" >/dev/null 2>&1 <<<"$body" && return 0
    sleep 0.25
  done
  echo "Timed out waiting for $filter at $url" >&2
  return 1
}

post_alert() {
  local name=$1 ends_at=${2:-}
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  [[ -z "$ends_at" ]] && ends_at=$(date -u -d '+5 minutes' +%Y-%m-%dT%H:%M:%SZ)
  jq -cn --arg name "$name" --arg now "$now" --arg ends "$ends_at" \
    '[{labels:{alertname:$name,severity:"critical",site:"site-smoke",device_id:"9001"},annotations:{summary:("Smoke "+$name)},startsAt:$now,endsAt:$ends,generatorURL:"http://smoke.local/test"}]' |
    curl -fsS -X POST -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:${alertmanager_port}/api/v2/alerts" >/dev/null
}

start_cloud

docker run -d --name "$container_name" \
  --network host \
  -v "$run_dir/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro" \
  -v "$run_dir/relay.token:/run/secrets/relay.token:ro" \
  quay.io/prometheus/alertmanager:v0.33.1 \
  --config.file=/etc/alertmanager/alertmanager.yml --storage.path=/alertmanager \
  --web.listen-address="127.0.0.1:${alertmanager_port}" --cluster.listen-address= >/dev/null
wait_http "http://127.0.0.1:${alertmanager_port}/-/ready"

ALERT_RELAY_HOST=0.0.0.0 ALERT_RELAY_PORT="$relay_port" \
ALERT_RELAY_TOKEN_FILE="$run_dir/relay.token" ALERT_CLOUD_URL="http://127.0.0.1:${cloud_port}" \
ALERT_CLOUD_TOKEN_FILE="$run_dir/cloud.token" ALERTMANAGER_URL="http://127.0.0.1:${alertmanager_port}" \
ALERT_QUEUE_DIR="$run_dir/queue" ALERT_SNAPSHOT_INTERVAL_MS=1000 ALERT_WORKER_INTERVAL_MS=100 \
  "$node_bin" "$project_root/alert-relay.mjs" >"$run_dir/relay.log" 2>&1 &
relay_pid=$!
wait_http "http://127.0.0.1:${relay_port}/health"

post_alert DeviceDownSmoke
curl -fsS "http://127.0.0.1:${alertmanager_port}/api/v2/alerts" >"$run_dir/alertmanager-alerts.json"
curl -fsS "http://127.0.0.1:${alertmanager_port}/api/v2/status" >"$run_dir/alertmanager-status.json"
sleep 2
curl -fsS "http://127.0.0.1:${relay_port}/health" >"$run_dir/relay-health.json"
curl -fsS "http://127.0.0.1:${alertmanager_port}/metrics" |
  grep -E '^(alertmanager_notification_requests_(failed_)?total|alertmanager_notifications_(failed_)?total)\{.*integration="webhook"' \
  >"$run_dir/alertmanager-notification-metrics.txt" || true
curl -sS -H "Authorization: Bearer $viewer_token" \
  "http://127.0.0.1:${cloud_port}/api/v1/cloud/monitoring/sources/librenms-smoke-01/alert-events" >"$run_dir/cloud-alert-events.json" || true
wait_json "http://127.0.0.1:${cloud_port}/api/v1/cloud/monitoring/sources/librenms-smoke-01/alert-events" \
  'any(.items[]?.alerts[]?; .labels.alertname == "DeviceDownSmoke" and .status == "firing")'
wait_json "http://127.0.0.1:${cloud_port}/api/v1/cloud/monitoring/sources/librenms-smoke-01/alerts" \
  '.alerts | any(.labels.alertname == "DeviceDownSmoke")'

kill "$cloud_pid"
wait "$cloud_pid" 2>/dev/null || true
cloud_pid=''
post_alert QueueWhileCloudDown
sleep 3
pending_count=$(find "$run_dir/queue/pending" -maxdepth 1 -type f -name '*.json' | wc -l)
[[ "$pending_count" -gt 0 ]]

start_cloud
wait_json "http://127.0.0.1:${cloud_port}/api/v1/cloud/monitoring/sources/librenms-smoke-01/alert-events" \
  'any(.items[]?.alerts[]?; .labels.alertname == "QueueWhileCloudDown")'

resolved_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
post_alert QueueWhileCloudDown "$resolved_at"
wait_json "http://127.0.0.1:${cloud_port}/api/v1/cloud/monitoring/sources/librenms-smoke-01/alert-events" \
  'any(.items[]?.alerts[]?; .labels.alertname == "QueueWhileCloudDown" and .status == "resolved")'

queue_bytes=$(du -sb "$run_dir/queue" | awk '{print $1}')
alertmanager_stats=$(docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' "$container_name")
relay_rss_kib=$(ps -o rss= -p "$relay_pid" | tr -d ' ')
cloud_rss_kib=$(ps -o rss= -p "$cloud_pid" | tr -d ' ')
formal_status=$(curl -fsS http://127.0.0.1:4310/api/v1/monitoring/health 2>/dev/null | jq -r '.status // "unknown"' || echo unavailable)

printf 'PASS live alert smoke\n'
printf 'alertmanager=%s relay_rss_kib=%s cloud_rss_kib=%s queue_bytes=%s formal_4310=%s\n' \
  "$alertmanager_stats" "$relay_rss_kib" "$cloud_rss_kib" "$queue_bytes" "$formal_status"

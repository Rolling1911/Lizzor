#!/usr/bin/env bash

set -Eeuo pipefail

port="${MOBILE_RESPONSIVE_PORT:-$(node --input-type=module -e '
  import net from "node:net";
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    console.log(server.address().port);
    server.close();
  });
')}"
base_url="http://127.0.0.1:${port}"
server_log="$(mktemp)"
server_pid=""

cleanup() {
  if [[ -n "${server_pid}" ]] && kill -0 "${server_pid}" 2>/dev/null; then
    kill -TERM -- "-${server_pid}" 2>/dev/null || kill -TERM "${server_pid}" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "${server_pid}" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-${server_pid}" 2>/dev/null || kill -KILL "${server_pid}" 2>/dev/null || true
  fi
  rm -f "${server_log}"
}
trap cleanup EXIT INT TERM

setsid env NODE_ENV=development PORT="${port}" npm run dev >"${server_log}" 2>&1 &
server_pid=$!

for _ in {1..120}; do
  if curl --fail --silent --show-error --max-time 1 "${base_url}/" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${server_pid}" 2>/dev/null; then
    cat "${server_log}" >&2
    exit 1
  fi
  sleep 0.25
done

if ! curl --fail --silent --show-error --max-time 2 "${base_url}/" >/dev/null 2>&1; then
  cat "${server_log}" >&2
  echo "Mobile responsive validation server did not become ready on ${base_url}." >&2
  exit 1
fi

BROWSER_BASE_URL="${base_url}" npm run test:mobile-responsive
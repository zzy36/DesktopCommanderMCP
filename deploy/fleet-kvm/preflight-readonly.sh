#!/usr/bin/env bash
set -euo pipefail

# Read-only preflight for the future fleet-mcp KVM. This script does not install,
# enable, restart, modify firewall rules, or change network configuration.

echo '=== OS ==='
cat /etc/os-release 2>/dev/null || true
uname -a

echo '=== CPU / MEMORY ==='
command -v nproc >/dev/null && nproc || true
command -v free >/dev/null && free -h || true

echo '=== STORAGE ==='
df -hT / /var /opt 2>/dev/null || df -hT /

echo '=== NETWORK ==='
command -v ip >/dev/null && ip -brief address || true
command -v ip >/dev/null && ip route || true

echo '=== DNS / OUTBOUND HTTPS ==='
getent ahostsv4 api.openai.com 2>/dev/null | head -n 5 || true
if command -v curl >/dev/null; then
  # Any HTTP response proves DNS/TCP/TLS reachability; authentication is not expected here.
  curl -sS -o /dev/null -w 'api.openai.com HTTPS status=%{http_code} connect=%{time_connect}s tls=%{time_appconnect}s\n' \
    --connect-timeout 5 --max-time 10 https://api.openai.com/v1/models || true
fi

echo '=== REQUIRED COMMANDS ==='
for cmd in node npm git caddy tunnel-client; do
  if command -v "$cmd" >/dev/null 2>&1; then
    printf '%-14s %s\n' "$cmd" "$(command -v "$cmd")"
  else
    printf '%-14s MISSING\n' "$cmd"
  fi
done

echo '=== LISTENERS OF INTEREST ==='
if command -v ss >/dev/null; then
  ss -lnt 2>/dev/null | awk 'NR==1 || /:8787 |:8788 |:9443 /'
else
  echo 'ss not installed'
fi

echo '=== EXPECTED DEPLOYMENT BOUNDARY ==='
echo 'MCP upstream:   127.0.0.1:8787 (loopback only)'
echo 'Agent upstream: 127.0.0.1:8788 (loopback only)'
echo 'LAN WSS:        planned :9443 via reverse proxy; confirm live LAN/DNS/PKI first'
echo 'WAN inbound:    none required for Secure MCP Tunnel'

echo 'PREFLIGHT_COMPLETE_READ_ONLY'

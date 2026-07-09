#!/usr/bin/env bash
# Regression guard for the Fase 0 security fixes in docs/ANALYSE_EN_VERBETERPLAN.md.
#
# NOTE on scope: NexusCommander is a Total-Commander-style file manager whose
# whole point is giving the logged-in user full filesystem access, so paths
# are intentionally NOT jailed to one root (see server/lib/security.js). The
# actual vulnerability this suite guards against is a browser tab on the same
# machine reaching into the backend cross-origin - that's what CORS/origin
# checks below verify. It also checks command-injection safety and the
# protected-root delete guard.
#
# Run before and after touching server/ - it must stay green.
set -uo pipefail

cd "$(dirname "$0")/.."

PORT=3721
BASE="http://127.0.0.1:$PORT"
ALLOWED_ORIGIN="http://localhost:5173"
ALLOWED_LAN_ORIGIN="http://127.0.0.1:4173"
EVIL_ORIGIN="http://evil.example"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "Starting backend on $BASE ..."
NC_HOST=0.0.0.0 node server/index.js > /tmp/nc-security-test-server.log 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" >/dev/null 2>&1; wait "$SERVER_PID" 2>/dev/null; }
trap cleanup EXIT

for i in $(seq 1 30); do
  if curl -s -o /dev/null "$BASE/"; then break; fi
  sleep 0.2
done

echo
echo "1) Cross-origin request from an untrusted page must be rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $EVIL_ORIGIN" "$BASE/api/system/os")
[ "$code" = "403" ] && pass "GET with foreign Origin -> 403 (got $code)" || fail "GET with foreign Origin -> expected 403, got $code"

echo
echo "2) Request from the app's own dev origin must be allowed"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $ALLOWED_ORIGIN" "$BASE/api/system/os")
[ "$code" = "200" ] && pass "GET with allowed Origin -> 200 (got $code)" || fail "GET with allowed Origin -> expected 200, got $code"

echo
echo "3) Request from the same backend host on the preview port must be allowed"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $ALLOWED_LAN_ORIGIN" "$BASE/api/system/os")
[ "$code" = "200" ] && pass "GET with same-host app Origin -> 200 (got $code)" || fail "GET with same-host app Origin -> expected 200, got $code"

echo
echo "4) Request with no Origin header (server-to-server, e.g. the Vite proxy) must be allowed"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/system/os")
[ "$code" = "200" ] && pass "GET with no Origin -> 200 (got $code)" || fail "GET with no Origin -> expected 200, got $code"

echo
echo "5) Malicious cross-origin POST (e.g. fs/delete) must be rejected before it touches the filesystem"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $EVIL_ORIGIN" -H 'Content-Type: application/json' \
  -X POST -d '{"path":"/tmp","recursive":true}' "$BASE/api/fs/delete")
[ "$code" = "403" ] && pass "POST /fs/delete with foreign Origin -> 403 (got $code)" || fail "POST /fs/delete with foreign Origin -> expected 403, got $code"

echo
echo "6) Command injection via open-file/open-terminal must not execute a second shell command"
MARKER="/tmp/nc-security-test-marker-$$"
rm -f "$MARKER"
curl -s -H "Origin: $ALLOWED_ORIGIN" -H 'Content-Type: application/json' \
  -X POST -d "{\"path\":\"/tmp; touch $MARKER #\"}" "$BASE/api/system/open-file" > /dev/null
sleep 0.5
if [ -f "$MARKER" ]; then
  fail "shell metacharacters in path were interpreted (marker file was created)"
  rm -f "$MARKER"
else
  pass "shell metacharacters in path were NOT interpreted"
fi

echo
echo "7) Deleting a protected root (the user's home directory itself) must be refused"
HOME_DIR=$(node -e "console.log(require('os').homedir())")
resp=$(curl -s -H "Origin: $ALLOWED_ORIGIN" -H 'Content-Type: application/json' \
  -X POST -d "{\"path\":\"$HOME_DIR\",\"recursive\":true}" "$BASE/api/fs/delete")
if echo "$resp" | grep -q '"error"'; then
  pass "delete of home directory itself was refused ($resp)"
else
  fail "delete of home directory itself was NOT refused ($resp)"
fi
[ -d "$HOME_DIR" ] && pass "home directory still exists after the attempted delete" || fail "home directory is GONE - critical failure"

echo
echo "----------------------------------------"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

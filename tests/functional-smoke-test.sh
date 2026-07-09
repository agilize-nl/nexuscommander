#!/usr/bin/env bash
# Exercises the real file-op/task/archive/search/system endpoints end-to-end
# against a live backend instance, using a scratch directory under /tmp.
set -uo pipefail

cd "$(dirname "$0")/.."

PORT=3721
BASE="http://127.0.0.1:$PORT/api"
ORIGIN="http://localhost:5173"
SCRATCH="/tmp/nc-smoke-$$"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

req() {
  # req METHOD PATH [JSON_BODY]
  local method="$1" p="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -X "$method" -d "$body" "$BASE$p"
  else
    curl -s -H "Origin: $ORIGIN" -X "$method" "$BASE$p"
  fi
}

echo "Starting backend on http://127.0.0.1:$PORT ..."
node server/index.js > /tmp/nc-smoke-server.log 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1; wait "$SERVER_PID" 2>/dev/null
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

for i in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 0.2
done

mkdir -p "$SCRATCH/src/nested" "$SCRATCH/dstA" "$SCRATCH/dstB"
echo "hello world" > "$SCRATCH/src/file1.txt"
echo "nested content" > "$SCRATCH/src/nested/file2.txt"
head -c 500000 /dev/urandom > "$SCRATCH/src/bigfile.bin"

echo
echo "=== fs: mkdir / read / info ==="
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -X POST -d "{\"path\":\"$SCRATCH/mkdirtest\"}" "$BASE/fs/mkdir")
[ "$code" = "200" ] && [ -d "$SCRATCH/mkdirtest" ] && pass "mkdir created directory" || fail "mkdir failed (code $code)"

names=$(req GET "/fs/read?path=$SCRATCH/src" | jq -r '.[].name' | sort | tr '\n' ',')
[ "$names" = "bigfile.bin,file1.txt,nested," ] && pass "fs/read lists correct entries ($names)" || fail "fs/read mismatch: $names"

symlink_flag=$(req GET "/fs/info?path=$SCRATCH/src/file1.txt" | jq -r '.is_symlink')
[ "$symlink_flag" = "false" ] && pass "fs/info is_symlink false for a regular file" || fail "fs/info is_symlink unexpected: $symlink_flag"

echo
echo "=== fs/copy: sync clipboard-paste path ==="
resp=$(req POST "/fs/copy" "{\"sources\":[\"$SCRATCH/src\"],\"targetDir\":\"$SCRATCH/dstA\"}")
ok=$(echo "$resp" | jq -r '.[0].success')
[ "$ok" = "true" ] && [ -f "$SCRATCH/dstA/src/file1.txt" ] && [ -f "$SCRATCH/dstA/src/nested/file2.txt" ] && pass "fs/copy copied directory tree recursively" || fail "fs/copy failed: $resp"

resp2=$(req POST "/fs/copy" "{\"sources\":[\"$SCRATCH/src\"],\"targetDir\":\"$SCRATCH/dstA\"}")
ok2=$(echo "$resp2" | jq -r '.[0].success')
[ "$ok2" = "false" ] && pass "fs/copy refuses to silently overwrite an existing file" || fail "fs/copy should have reported a conflict: $resp2"

echo
echo "=== fs/move: sync clipboard-cut path ==="
mkdir -p "$SCRATCH/movesrc"
echo "move me" > "$SCRATCH/movesrc/m.txt"
resp=$(req POST "/fs/move" "{\"sources\":[\"$SCRATCH/movesrc\"],\"targetDir\":\"$SCRATCH/dstB\"}")
ok=$(echo "$resp" | jq -r '.[0].success')
[ "$ok" = "true" ] && [ -f "$SCRATCH/dstB/movesrc/m.txt" ] && [ ! -e "$SCRATCH/movesrc" ] && pass "fs/move moved dir and pruned empty source" || fail "fs/move failed: $resp"

echo
echo "=== tasks: real copy execution with progress ==="
task_id=$(req POST "/tasks/create" "{\"taskType\":\"copy\",\"sources\":[\"$SCRATCH/src\"],\"target\":\"$SCRATCH/dstC\"}" | tr -d '"')
mkdir -p "$SCRATCH/dstC"
req POST "/tasks/$task_id/execute" > /dev/null
for i in $(seq 1 50); do
  status=$(req GET "/tasks/$task_id/status" | jq -r '.status')
  [ "$status" = "Completed" ] || [ "$status" = "Failed" ] && break
  sleep 0.1
done
final=$(req GET "/tasks/$task_id/status")
status=$(echo "$final" | jq -r '.status')
processed=$(echo "$final" | jq -r '.processed_files')
total=$(echo "$final" | jq -r '.total_files')
[ "$status" = "Completed" ] && [ "$processed" = "$total" ] && [ -f "$SCRATCH/dstC/src/bigfile.bin" ] && pass "task copy completed ($processed/$total files)" || fail "task copy failed: $final"

echo
echo "=== tasks: conflict pause + resolve-conflict ==="
task_id2=$(req POST "/tasks/create" "{\"taskType\":\"copy\",\"sources\":[\"$SCRATCH/src\"],\"target\":\"$SCRATCH/dstC\"}" | tr -d '"')
req POST "/tasks/$task_id2/execute" > /dev/null
waited=""
for i in $(seq 1 50); do
  st=$(req GET "/tasks/$task_id2/status" | jq -r '.status')
  if [ "$st" = "WaitingForInput" ]; then waited="yes"; break; fi
  [ "$st" = "Completed" ] || [ "$st" = "Failed" ] && break
  sleep 0.1
done
[ "$waited" = "yes" ] && pass "task paused with WaitingForInput on conflict" || fail "task never paused for conflict (last status: $st)"

req POST "/tasks/$task_id2/resolve-conflict" '{"resolution":"overwrite_all"}' > /dev/null
for i in $(seq 1 50); do
  st=$(req GET "/tasks/$task_id2/status" | jq -r '.status')
  [ "$st" = "Completed" ] || [ "$st" = "Failed" ] && break
  sleep 0.1
done
[ "$st" = "Completed" ] && pass "resolve-conflict(overwrite_all) let the task finish" || fail "task did not complete after resolve-conflict: $st"

echo
echo "=== tasks: cancel while paused on a conflict ==="
task_id3=$(req POST "/tasks/create" "{\"taskType\":\"copy\",\"sources\":[\"$SCRATCH/src\"],\"target\":\"$SCRATCH/dstC\"}" | tr -d '"')
req POST "/tasks/$task_id3/execute" > /dev/null
for i in $(seq 1 50); do
  st=$(req GET "/tasks/$task_id3/status" | jq -r '.status')
  [ "$st" = "WaitingForInput" ] && break
  sleep 0.1
done
req POST "/tasks/$task_id3/cancel" > /dev/null
sleep 0.3
st=$(req GET "/tasks/$task_id3/status" | jq -r '.status')
[ "$st" = "Cancelled" ] && pass "cancel while paused on conflict unblocks the task" || fail "task not cancelled: $st"

echo
echo "=== tasks: delete ==="
mkdir -p "$SCRATCH/todelete"; echo x > "$SCRATCH/todelete/x.txt"
task_id4=$(req POST "/tasks/create" "{\"taskType\":\"delete\",\"sources\":[\"$SCRATCH/todelete\"],\"target\":\"\"}" | tr -d '"')
req POST "/tasks/$task_id4/execute" > /dev/null
for i in $(seq 1 50); do
  st=$(req GET "/tasks/$task_id4/status" | jq -r '.status')
  [ "$st" = "Completed" ] || [ "$st" = "Failed" ] && break
  sleep 0.1
done
[ "$st" = "Completed" ] && [ ! -e "$SCRATCH/todelete" ] && pass "task delete removed the directory" || fail "task delete failed: $st"

echo
echo "=== fs/drives, fs/compare, fs/dirsize ==="
drive_count=$(req GET "/fs/drives" | jq 'length')
[ "$drive_count" -ge 1 ] && pass "fs/drives returned $drive_count real mount(s)" || fail "fs/drives returned nothing"

mkdir -p "$SCRATCH/cmpL" "$SCRATCH/cmpR"
echo same > "$SCRATCH/cmpL/same.txt"; echo same > "$SCRATCH/cmpR/same.txt"
touch -d "2020-01-01" "$SCRATCH/cmpL/same.txt" "$SCRATCH/cmpR/same.txt"
echo diffL > "$SCRATCH/cmpL/diff.txt"; echo diffR > "$SCRATCH/cmpR/diff.txt"
echo onlyL > "$SCRATCH/cmpL/onlyleft.txt"
cmp=$(req GET "/fs/compare?left=$SCRATCH/cmpL&right=$SCRATCH/cmpR")
ol=$(echo "$cmp" | jq -r '.only_in_left[0]')
diffn=$(echo "$cmp" | jq -r '.different[0]')
idn=$(echo "$cmp" | jq -r '.identical[0]')
[ "$ol" = "onlyleft.txt" ] && [ "$diffn" = "diff.txt" ] && [ "$idn" = "same.txt" ] && pass "fs/compare categorized correctly" || fail "fs/compare wrong: $cmp"

expected_size=$(du -cb "$SCRATCH/src" | tail -1 | cut -f1)
actual_size=$(req GET "/fs/dirsize?path=$SCRATCH/src")
[ "$actual_size" = "$expected_size" ] && pass "fs/dirsize matches du -b ($actual_size bytes)" || fail "fs/dirsize mismatch: got $actual_size expected $expected_size"

echo
echo "=== fs/search ==="
mkdir -p "$SCRATCH/searchroot/sub"
echo "needle inside" > "$SCRATCH/searchroot/sub/target.txt"
echo "nothing here" > "$SCRATCH/searchroot/other.txt"
byname=$(req POST "/fs/search" "{\"params\":{\"query\":\"target\",\"start_dir\":\"$SCRATCH/searchroot\",\"use_regex\":false,\"content_query\":null}}" | jq 'length')
[ "$byname" = "1" ] && pass "fs/search finds by filename substring" || fail "fs/search by name found $byname results"
bycontent=$(req POST "/fs/search" "{\"params\":{\"query\":\"*.txt\",\"start_dir\":\"$SCRATCH/searchroot\",\"use_regex\":false,\"content_query\":\"needle\"}}" | jq 'length')
[ "$bycontent" = "1" ] && pass "fs/search filters by content_query" || fail "fs/search content filter found $bycontent results"

echo
echo "=== archive: pack / check / read / test / unpack ==="
mkdir -p "$SCRATCH/archsrc"
echo "archived content" > "$SCRATCH/archsrc/a.txt"
req POST "/archive/pack" "{\"sources\":[\"$SCRATCH/archsrc\"],\"destPath\":\"$SCRATCH/out.zip\"}" > /dev/null
is_arch=$(req GET "/archive/check?path=$SCRATCH/out.zip")
[ "$is_arch" = "true" ] && pass "archive/check recognizes the zip" || fail "archive/check false for out.zip"
entry_count=$(req GET "/archive/read?path=$SCRATCH/out.zip" | jq 'length')
[ "$entry_count" -ge 1 ] && pass "archive/read lists $entry_count entr(y/ies)" || fail "archive/read listed nothing"
test_ok=$(req GET "/archive/test?path=$SCRATCH/out.zip")
[ "$test_ok" = "true" ] && pass "archive/test reports the zip as valid" || fail "archive/test reported invalid"
req POST "/archive/unpack" "{\"srcPath\":\"$SCRATCH/out.zip\",\"destDir\":\"$SCRATCH/unpacked\"}" > /dev/null
if [ -f "$SCRATCH/unpacked/archsrc/a.txt" ]; then
  content=$(cat "$SCRATCH/unpacked/archsrc/a.txt")
  [ "$content" = "archived content" ] && pass "archive/unpack restored original content" || fail "unpacked content mismatch: $content"
else
  fail "archive/unpack did not produce expected file"
fi

echo
echo "=== archive: split / combine round-trip ==="
head -c 250000 /dev/urandom > "$SCRATCH/splitme.bin"
orig_hash=$(sha256sum "$SCRATCH/splitme.bin" | cut -d' ' -f1)
mkdir -p "$SCRATCH/parts"
req POST "/archive/split" "{\"path\":\"$SCRATCH/splitme.bin\",\"chunkSize\":100000,\"destDir\":\"$SCRATCH/parts\"}" > /dev/null
part_count=$(ls "$SCRATCH/parts" | wc -l)
[ "$part_count" = "3" ] && pass "archive/split produced 3 parts for a 250000-byte file at 100000 chunk size" || fail "archive/split produced $part_count parts"
parts_sorted=$(ls "$SCRATCH/parts"/splitme.bin.* | sort | jq -R . | jq -s .)
req POST "/archive/combine" "{\"sources\":$parts_sorted,\"destPath\":\"$SCRATCH/recombined.bin\"}" > /dev/null
new_hash=$(sha256sum "$SCRATCH/recombined.bin" | cut -d' ' -f1)
[ "$orig_hash" = "$new_hash" ] && pass "archive/combine round-trip is byte-identical" || fail "combine mismatch: $orig_hash vs $new_hash"

echo
echo "=== system/execute ==="
out=$(req POST "/system/execute" "{\"command\":\"echo hello-nc-test\",\"currentDir\":\"$SCRATCH\"}")
echo "$out" | grep -q "hello-nc-test" && pass "system/execute ran a shell command and returned output" || fail "system/execute unexpected output: $out"

echo
echo "=== system/open-with (read-only query) ==="
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $ORIGIN" "$BASE/system/open-with?path=$SCRATCH/src/file1.txt")
[ "$code" = "200" ] && pass "system/open-with responded 200" || fail "system/open-with returned $code"

echo
echo "----------------------------------------"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

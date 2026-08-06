#!/usr/bin/env bash
#
# Drive the machine over the wire protocol directly, with no CLI involved.
#
# The CLI is a convenience, not the interface. `POST /rpc` is plain JSON-RPC 2.0
# over HTTP, so anything that can make an HTTP request can drive the emulator —
# a language with no Node in sight, a CI step, or curl in a shell script.
#
# See docs/DEBUG-PROTOCOL.md for the full method list.

source "$(dirname "$0")/lib.sh"

say '1. Start a machine and find it the way any client would'

start_emulator --pause

# A running emulator publishes where to reach it, so a client needs no
# configuration. ~/.6502-kim/session.json is 0600 — it holds the token that
# authorises driving the machine.
#
# Not ~/.6502/session.json: that one belongs to 6502-EMULATOR, both are expected
# on the same machine, and a client that found the wrong one would be driving an
# ACE and wondering where the keypad went.
LOCK="${SIXTY5O2_KIM_HOME:-$HOME/.6502-kim}/session.json"
show "cat $LOCK"
node -e '
  const lock = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  // Everything except the token, which should not end up in a CI log.
  const { token, ...rest } = lock
  console.log(JSON.stringify({ ...rest, token: "(redacted)" }, null, 2))
' "$LOCK"

PORT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port)' "$LOCK")
TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token)' "$LOCK")

# A one-line JSON-RPC call. Two headers matter, and both are load-bearing:
#
#   Content-Type: application/json   Required. It is the one content type a web
#                                    page cannot send cross-origin without a
#                                    preflight, which this server never answers —
#                                    so it stops a page the user happens to have
#                                    open from firing commands at the machine.
#   Authorization: Bearer <token>    Optional on loopback, required otherwise.
rpc() {
  local method="$1" params="${2:-null}"
  curl -sS -X POST "http://127.0.0.1:$PORT/rpc" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"
}

# Pull a field out of a reply: `rpc lcd.text | result lines.0`.
result() {
  node -e '
    let text = ""
    process.stdin.on("data", (chunk) => { text += chunk })
    process.stdin.on("end", () => {
      const reply = JSON.parse(text)
      const value = process.argv[1]
        .split(".")
        .reduce((object, key) => (object === undefined ? undefined : object[key]), reply.result)
      process.stdout.write(typeof value === "string" ? value : JSON.stringify(value))
    })
  ' "$1"
}

say '2. Ask what the machine is'

show "curl -X POST http://127.0.0.1:\$PORT/rpc -H 'Content-Type: application/json' \\
    -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session.info\"}'"
info=$(rpc session.info)
printf '%s\n' "$info" | node -e '
  let text = ""
  process.stdin.on("data", (c) => { text += c })
  process.stdin.on("end", () => console.log(JSON.stringify(JSON.parse(text).result, null, 2).slice(0, 400)))
'
expect_match 'it speaks protocol version 1' "$info" '"protocol":1'
expect_match 'the Serial Card is fitted' "$info" '"serialCard":true'

say '3. Boot it, and read the glass'

# exec.runCycles is the exact-budget primitive; the machine was started paused,
# so this is the whole boot in one call and it lands on the same cycle every run.
rpc exec.runCycles '{"cycles":3000000}' >/dev/null
expect 'the splash' "$(rpc lcd.text | result lines.0)" 'KIM MONITOR v1.0'

# keypad.press takes a name, an encoder code, or a list of either. The code is
# not the key's value — `0` is $0A and C-F run backwards — so pass names and let
# the machine's own table do the mapping.
rpc keypad.press '{"key":"ESC"}' >/dev/null
rpc exec.runCycles '{"cycles":200000}' >/dev/null
rpc keypad.press '{"key":["0","8","0","0"],"kps":50}' >/dev/null
rpc exec.run '{"mode":"turbo"}' >/dev/null
rpc wait.for '{"cycles":2000000,"timeoutMs":20000}' >/dev/null

expect_match 'the monitor took the address' "$(rpc lcd.text | result lines.0)" '\$0800'

# lcd.pixels is the same panel as a dot matrix, one byte per dot: 255 is the gap
# between characters, 0 an unlit dot, 1 a lit one. The unlit dots are the point —
# on this display you can see them, and a renderer that drew only the lit ones
# would not look like an LCD at all.
pixels=$(rpc lcd.pixels)
expect 'the pixel buffer is 16 x 2 characters' \
  "$(printf '%s' "$pixels" | result cols)x$(printf '%s' "$pixels" | result rows)" '16x2'

say '4. Type at it, and use the cursor rather than a sleep'

# serial.write returns the console cursor as it stood before the write, and
# wait.for takes it back — which is what makes "wait for the reply to what I just
# sent" correct even though the machine runs hundreds of thousands of cycles
# between the two calls.
cursor=$(rpc serial.write '{"data":"0300.0303\r"}' | result cursor)
printf '   console cursor at the moment of the write: %s\n' "$cursor"

reply=$(rpc wait.for "{\"serial\":\"0300:\",\"since\":$cursor,\"timeoutMs\":20000}")
output=$(printf '%s' "$reply" | result output)
printf '%s\n' "$output"
expect_match 'the monitor answered the examine' "$output" '0300:'

say '5. Read memory — bytes come back as base64'

read_result=$(rpc mem.read '{"address":"$0800","length":8}')
printf '%s\n' "$read_result"
expect_match 'the reply carries base64 data' "$read_result" '"data":"'

# The accessory bay is on the bus like anything else, and reading it is how you
# find out it does not read back: a 74HC373 has no read strobe.
expect 'the empty bay at $9400' "$(rpc mem.read '{"address":"$9400","length":4}' | result data)" 'AAAAAA=='

say '6. Errors are JSON-RPC errors, with codes a client can branch on'

# -32601 METHOD_NOT_FOUND, -32602 INVALID_PARAMS, -32000 NOT_SUPPORTED.
expect_match 'an unknown method' "$(rpc nonsense.method)" '"code":-32601'
expect_match 'a bad parameter' "$(rpc mem.read '{"address":"nowhere"}')" '"code":-32602'

# The ACE's methods for hardware this machine does not have are not stubs that
# return nothing — they are not there at all, which is the answer a client can
# act on.
expect_match 'a method belonging to the video card' "$(rpc screen.text)" '"code":-32601'

say '7. The guards are real'

status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/rpc" \
  -H 'Content-Type: text/plain' -H "Authorization: Bearer $TOKEN" -d '{}')
expect 'a request without the JSON content type' "$status" 415

status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/rpc" \
  -H 'Content-Type: application/json' -H 'Origin: https://example.com' \
  -H "Authorization: Bearer $TOKEN" -d '{}')
expect 'a request carrying a browser Origin' "$status" 401

status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/rpc" \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer wrong' -d '{}')
expect 'a request with the wrong token' "$status" 401

status=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/anything")
expect 'any other endpoint' "$status" 404

say 'Example 5 passed'

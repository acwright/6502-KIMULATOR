import { dispatch, COMMAND_NAMES } from './dbg/Commands'

export const DBG_HELP = `Usage: 6502-kim dbg <command> [options]

One-shot debug commands against a running emulator. Each connects, calls,
prints its result, and exits — nothing here keeps a session open; that is
what "6502-kim attach" is for.

Connection (every command accepts these)
  --port <n>       Talk to this port instead of reading ~/.6502-kim/session.json
  --host <addr>    Host to connect to (default: 127.0.0.1)
  --token <token>  Override the token from the lock file
  --json           Print the raw JSON-RPC result instead of formatted text

Commands
  info                             What the machine is and what it's doing
  regs [--set A=0x42 ...]          Read or write the registers
  reset [--warm]                   Reset the machine (cold by default)
  config [--baud n]

  mem <addr> [length] [--space cpu|ram|rom|card]
  mem write <addr> <bytes>         Bytes as hex ("DEADBEEF") or a byte list
  mem fill <addr> <length> <value>
  mem search <pattern> [--text] [--start] [--end] [--limit]

  disasm [addr] [count]
  disasm range <start> <end>

  break <addr> [--watch read|write|access] [--condition expr]
               [--end addr] [--ignore n] [--temporary] [--disabled]
  break list
  break clear [id]                 Omit id to clear every breakpoint
  break enable <id> / disable <id>

  run [--realtime]                 Resume; turbo unless --realtime
  pause
  step [--over|--out|--cycle] [--count n]
  runto <addr> [--timeout dur] [--realtime]
  runcycles <n>

  send <text> [--wait pattern] [--timeout dur] [--encoding base64]
  wait [--serial pattern] [--stopped] [--cycles n] [--expression expr]
       [--since n] [--timeout dur] [--run turbo|realtime]

  sym load <file> [--format vice|ca65|lst] [--no-merge]
  sym resolve <name>
  sym lookup <addr>
  sym list [prefix] [--limit n]

  load rom|card-rom <file>
  load bin <addr> <file>

  key <name|$code> [more ...] [--kps n]   Press keys on the pad, in order
  key --list                              The pad, with every encoder code

  lcd [text]                       The two lines, as the panel shows them
  lcd hash                         Cheap digest — "did the panel change"
  lcd pixels                       The dot matrix, as characters

  state save [file]                Save the whole machine (default machine.state)
  state load [file] [--force]      Restore it; --force accepts a ROM mismatch

Exit codes
  0  ok                    2  timed out
  1  usage or RPC error     3  no emulator found
                            4  a breakpoint or watchpoint fired

Notes
  There is no "screen" and no "input" — this machine has a 16x2 LCD and a
  24-key pad instead of a video card, a keyboard and joysticks, so "lcd" and
  "key" stand where those did. There is no "unload cart" either: the Keypad
  Card is soldered in.

  "key" presses and never releases, because the 74C922 encoder reports the
  press and nothing else. Give a whole sequence to one call — the pacing that
  keeps the latch from losing a keystroke is measured in emulated cycles, and
  separate processes cannot pace anything.

Examples
  6502-kim dbg regs
  6502-kim dbg key 0 8 0 0        # key an address into the monitor
  6502-kim dbg lcd
  6502-kim dbg break MonitorLoop --condition 'A == 0xFF'
  6502-kim dbg send '0200: A9 41\\r' --wait '\\.' --timeout 5s

  # Boot once, then restore per test case instead of re-booting.
  6502-kim dbg wait --serial 'KIM' && 6502-kim dbg state save ready.state
  6502-kim dbg state load ready.state && 6502-kim dbg key A
`

export async function dbgCommand(argv: string[]): Promise<number> {
  const [command, ...rest] = argv

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(DBG_HELP)
    return 0
  }

  if (!COMMAND_NAMES.includes(command) && command !== 'reg') {
    process.stderr.write(`6502-kim dbg: unknown command "${command}"\n\n${DBG_HELP}`)
    return 1
  }

  return dispatch(command, rest)
}

#!/usr/bin/env bash
#
# Key a program in on the pad, exactly as the printed card says to, and run it.
#
# This is the machine's own way in — 24 keys and two lines of glass — and it
# works on a KIM with no Serial Card at all. The keys go over the debug protocol
# as `keypad.press`; there is no `type` and no release, because the MM74C922
# reports a press and nothing else.
#
# The procedure is the one on the 6502-DOCS type-in cards:
#
#   0 8 0 0     key the start address, a nibble at a time
#   INS         enter data-edit mode
#   A 9 ►       key each byte as two hex digits, then step to the next address
#   INS         leave data-edit mode
#   0 8 0 0     back to the start
#   ▲           run
#   ESC         stop, back to the monitor

source "$(dirname "$0")/lib.sh"

# The program keyed in below is LDA #$5A / STA $0900 / RTS — A9 5A 8D 00 09 60.
# It ends in RTS rather than STP because the pad's ▲ is a JSR: DoUp calls
# through CUR_ADDR, and a user RTS lands back in the monitor with the machine
# still usable. (The serial side's `R` is Wozmon's, a JMP; see example 01.)

say '1. Boot, and take the splash at its word'

# --pause holds the machine on its reset vector — read out of the Keypad Card,
# not the BIOS — so the boot itself can be bought in cycles rather than waited
# out. `wait --cycles ... --run turbo` resumes and stops on an exact budget.
show '6502-kim run --headless --debug --pause   # then: dbg wait --cycles 3e6 --run turbo'
start_emulator --pause

show '6502-kim dbg key ESC'
boot_to_monitor
dbg lcd

# Booting to here costs about 1.8 M cycles, almost all of it the HD44780's four
# ~41 ms power-on delays. Pay it once and restore per case below.
dbg state save "$WORK/ready.state" >/dev/null
printf '   saved the machine at the monitor\n'

say '2. Key the address'

show '6502-kim dbg key 0 8 0 0'
dbg key 0 8 0 0
dbg lcd

# The panel is the assertion: this is what a person looking at the glass reads.
expect_match 'the monitor moved to $0800' "$(dbg lcd)" '\$0800'

# A bare number is a *name*, not a code. `key 0` presses the zero key, and the
# encoder reports $0A for it — the switches are numbered in board order, so
# nothing may derive one from the other. `key '$0A'` says the same thing by code.
show '6502-kim dbg key --list'
dbg key --list

say '3. Key the bytes'

# One call, not twelve. The pacing that keeps the latch from losing a keystroke
# is measured in emulated cycles: the encoder holds one code, and the CA1
# interrupt handler's read is what makes room for the next. Twelve separate
# processes would lose eleven of them.
#
# RIGHT is the ► key; the glyph works too, and so does the encoder code $0B.
show '6502-kim dbg key INS  A 9 RIGHT  5 A RIGHT  8 D RIGHT  0 0 RIGHT  0 9 RIGHT  6 0  INS'
dbg key INS
dbg key A 9 RIGHT 5 A RIGHT 8 D RIGHT 0 0 RIGHT 0 9 RIGHT 6 0
dbg key INS
dbg lcd

expect 'the bytes in RAM' "$(dbg mem 0x0800 6 --json | json data)" 'qVqNAAlg'
expect_match 'and the panel is sitting on the last of them' "$(dbg lcd)" '\$0805: \$60'

say '4. Name it, and break on it'

# Symbols work anywhere an address does. A VICE label file is two columns and
# needs no toolchain, which is why this example writes one; `--format ca65`
# reads a .dbg and `--format lst` a ca65 listing, and that last one is what a
# `cl65 -l` build of KC Monitor.bin leaves behind — the ROM a KIM session spends
# most of its time in.
printf 'al 000800 .keyedProgram\n' > "$WORK/labels.lbl"

show '6502-kim dbg sym load labels.lbl && 6502-kim dbg disasm keyedProgram 3'
dbg sym load "$WORK/labels.lbl"
dbg disasm keyedProgram 3

# Which is the keyed bytes read back as instructions — the card's listing,
# recovered from the machine that was typed into.
expect_match 'the disassembly' "$(dbg disasm keyedProgram 3)" 'LDA #\$5A'

show '6502-kim dbg break keyedProgram'
dbg break keyedProgram

say '5. Run it from the pad'

show '6502-kim dbg key 0 8 0 0 && 6502-kim dbg key UP'
dbg key 0 8 0 0
dbg key UP

# UP is ▲, and it is also spelled ENTER or RUN. The breakpoint stops the machine
# on the program's first instruction, which is the proof that ▲ really did
# transfer control there.
show '6502-kim dbg wait --stopped --timeout 10s'
dbg wait --stopped --timeout 10s

# `--stopped` is satisfied by a machine that has already stopped, which for a
# one-shot caller is the normal case rather than an edge one: in turbo the
# breakpoint armed by one command has usually fired before the next connects.
expect 'what stopped it' "$(dbg wait --stopped --timeout 10s --json | json stop.kind)" breakpoint
expect 'the program counter' "$(dbg regs --json | json PC)" 2048

dbg break clear
dbg run

# The program stores $5A at $0900 and returns; the monitor is still there
# afterwards, which is the difference between ▲ and the serial monitor's R.
expect 'the program ran to the end' \
  "$(dbg wait --expression '[$0900] == $5A' --timeout 5s --json | json matched)" true
expect_match 'and the monitor survived it' "$(dbg lcd)" '\$0800'

say '6. Restore, and do it again with different bytes'

# The whole point of saving at the monitor: a second case costs a millisecond,
# not another 1.8 M cycles. A snapshot records the machine's shape as well as its
# contents — a different slot layout, or either ROM's checksum not matching, is
# refused rather than half-applied.
show '6502-kim dbg state load ready.state'
dbg state load "$WORK/ready.state"

expect 'the restored machine has forgotten $0900' "$(dbg mem 0x0900 1 --json | json data)" 'AA=='

dbg key 1 2 3 4
expect_match 'and takes an address again' "$(dbg lcd)" '\$1234'

say 'Example 2 passed'

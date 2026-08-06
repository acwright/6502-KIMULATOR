import { UsageError } from '../args'

/**
 * Turn `\r`, `\n`, `\t`, `\xNN` and `\\` written literally in a shell argument
 * into the bytes they mean.
 *
 * A single-quoted shell string cannot contain a real carriage return, and
 * `6502-kim dbg send '0200R\r'` — a Wozmon run command, which the monitor acts
 * on when it sees the CR — depends on the CLI doing this translation rather than
 * the shell.
 *
 * `\xNN` is here where 6502-EMULATOR's copy has no such thing, because of one
 * byte: the KC Monitor's splash waits for ESC, so `\x1b` is the first thing
 * most scripted sessions send, and a raw ESC cannot be put in a shell argument
 * either. The alternative is `--encoding base64 Gw==`, which works and reads
 * like nothing at all.
 */
export function unescape(text: string): string {
  return text.replace(/\\(?:x([0-9a-fA-F]{2})|(r|n|t|\\))/g, (_, hex: string, code: string) => {
    if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16))
    return code === 'r' ? '\r' : code === 'n' ? '\n' : code === 't' ? '\t' : '\\'
  })
}

/**
 * A list of bytes, written as hex pairs (`DEADBEEF`), or comma/space separated
 * values (`0xDE, 0xAD` or `222,173`) — whichever reads naturally for the call.
 */
export function parseByteList(text: string, label: string): number[] {
  const trimmed = text.trim()
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0 && !trimmed.includes(' ')) {
    const bytes: number[] = []
    for (let i = 0; i < trimmed.length; i += 2) bytes.push(parseInt(trimmed.slice(i, i + 2), 16))
    return bytes
  }

  return trimmed
    .split(/[\s,]+/)
    .filter((token) => token.length > 0)
    .map((token) => {
      const hex = token.startsWith('$') ? token.slice(1) : /^0x/i.test(token) ? token.slice(2) : null
      const value = hex === null ? Number(token) : parseInt(hex, 16)
      if (!Number.isInteger(value) || value < 0 || value > 0xff) {
        throw new UsageError(`${label}: expected bytes 0-255, got "${token}"`)
      }
      return value
    })
}

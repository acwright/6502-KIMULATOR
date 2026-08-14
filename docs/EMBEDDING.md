# Embedding the KIMulator

The web build ships two pages. `index.html` is the full emulator; `embed.html`
is the same machine sized for an `<iframe>` on somebody else's page — no
settings panel, no host serial port, no paste box, no file pickers, and nothing
written to disk.

```html
<iframe
  src="https://acwright.github.io/6502-KIMULATOR/embed.html?panels=lcd,keys&keys=ESC"
  width="360" height="520"
  allow="fullscreen"
  style="border: 0"
></iframe>
```

That is the whole integration. Everything below is optional.

**One thing to know before anything else: the machine boots to a splash reading
`--ESC TO START--` and means it.** Nothing else runs until an ESC arrives — the
pad's `ESC` key or a `\x1b` on the wire, either one starting both consoles, and
no other key or byte doing anything. So an embed that should show a *working* monitor
rather than a waiting one says `keys=ESC`, and one that types at the serial port
sends an ESC first — `autotype=\x1b…`. That is the hardware, not a quirk of the
frame: a real KIM sits on the same splash until you touch it.

---

## Contents

- [URL parameters](#url-parameters)
- [Panels](#panels)
- [The pad: `keys`](#the-pad-keys)
- [The serial line: `autotype`](#the-serial-line-autotype)
- [Inline payloads: the `64` suffix](#inline-payloads-the-64-suffix)
- [CORS and CSP](#cors-and-csp)
- [Keyboard focus](#keyboard-focus)
- [Sizing](#sizing)
- [The `postMessage` API](#the-postmessage-api)
- [The `embed.js` loader](#the-embedjs-loader)
- [Caveats](#caveats)

---

## URL parameters

| Parameter | Default | Meaning |
|---|---|---|
| `rom` | bundled BIOS | URL of a 32 KB BIOS image |
| `bin` | — | `<address>=<url>`, raw bytes at an explicit address in RAM. Repeatable |
| `accessory` | none | What is wired to the bay at `$9400`. `led-latch`, or `none` |
| `serialcard` | `1` | Whether io5 holds the ACIA. `0` gives the keypad-only machine |
| `panels` | all four | Which of `terminal`, `lcd`, `keys`, `accessory` are shown |
| `keys` | — | A sequence keyed on the pad once the machine is up, e.g. `ESC,0,8,0,0,UP` |
| `autotype` | — | Text typed down the serial line once the machine is up |
| `autostart` | `1` | Boot the machine on load |
| `controls` | `minimal` | `full` \| `minimal` \| `none` |
| `origins` | any | Comma-separated origins allowed to drive the frame over `postMessage` |

`rom` and `bin` also have a `64` form that carries the bytes in the URL itself.
See [Inline payloads](#inline-payloads-the-64-suffix).

**Flags** (`autostart`, `serialcard`) accept `1`/`0`, `true`/`false`, `yes`/`no`,
`on`/`off`, or bare presence: `?serialcard` means `serialcard=1`.

**Addresses** in `bin` are written the way the CLI writes them — `$0800`,
`0x0800` or plain decimal — and must land in RAM, which ends at `$7FFF`.

**Nothing here is fatal.** A malformed value falls back to its default and logs a
warning to the console and to a dismissible banner in the frame; an unrecognised
parameter is ignored outright. That is deliberate: if you pin an emulator version
and later start passing a parameter that version has never heard of, you get a
working emulator, not a blank frame.

### What a KIM does not have

6502-EMULATOR's embed takes `cart`, `prg`, `cf`, `cfsize`, `persist`, `muted` and
`freq`. Every one of them went with hardware this machine does not carry: there
is no cartridge slot — the Keypad Card *is* the cartridge, and it is soldered in
— no BASIC to load a `.prg` into, no CompactFlash, no sound, and one clock, since
PHI2 on this board is 1 MHz. Nothing persists either: a real KIM loses its RAM
when you switch it off, and so does this one.

The Keypad Card's own ROM is not a parameter either. It is loadable in the
desktop app, from Settings, because trying a freshly built `KC Monitor.bin`
without burning an AT28C64 is a real thing to want — but that is changing the
machine's firmware, and it belongs where you have to mean it.

---

## Panels

The KIM is four things you can look at, and `panels=` chooses which of them the
frame shows:

| Name | Also accepts | What it is |
|---|---|---|
| `terminal` | `term`, `serial` | 40×24, white on black — what the serial port sees, both ways |
| `lcd` | `display` | The 16×2 HD44780 on the Keypad LCD Helper |
| `keys` | `keypad`, `pad` | The 24-key pad |
| `accessory` | `bay`, `leds` | The bus at `$9400` and whatever is wired to it |

```
?panels=lcd,keys        the machine you hold
?panels=terminal        the serial monitor alone
?panels=lcd,accessory   a program's output, with no way to interfere
```

They come back in layout order however you write them, so the panels sit the way
they sit on the bench. A name it does not recognise is dropped with a warning; a
list where *nothing* is recognised shows all four, because a blank rectangle is
indistinguishable from a broken embed.

**Hiding a panel hides the view, never the hardware.** The LCD is still being
driven behind `panels=terminal`, the ACIA still transmits, and the latch still
lights lamps nobody can see. A KIM is not assembled out of its panels.

Two of them take the keyboard — the terminal and the pad. A frame showing
neither is a machine you can watch and not touch, which is a reasonable thing to
put beside a paragraph.

---

## The pad: `keys`

A sequence, comma-separated, pressed once the machine reaches its splash:

```
?keys=ESC                     start the monitor and stop there
?keys=ESC,0,8,0,0             start it and key an address
?keys=ESC,UP                  start it and run from wherever it is pointing
?bin64=$0800=…&keys=ESC,UP    load a program and run it
```

Names are the pad's own legends — `0`–`9`, `A`–`F`, `ESC`, `INS`, `DEL`, `PGUP`,
`PGDN` — case-insensitively, plus `LEFT`, `RIGHT`, `UP`, `ENTER` and `RUN` for
the three keys legended with an arrow. A token written `$14` or `0x14` is the
encoder's own code instead.

**A bare number is a name, not a code**, exactly as in `6502-kim dbg key`. `0`
presses the zero key, which reports `$0A`; the code is not the value printed on
the cap, and `C`–`F` run backwards. Nothing derives one from the other.

One bad token refuses the whole sequence rather than keying part of it: half an
address left in the monitor is worse than none, and much harder to see
afterwards.

Presses are paced at eight a second. That is not politeness — the MM74C922
latches a single code and raises data-available, and the KC Monitor's interrupt
handler reading it is what clears the latch. Two presses with no emulated time
between them and the first one is simply gone.

---

## The serial line: `autotype`

Bytes at the ACIA, exactly as if they had arrived from a real port — so this
takes anything the KC Monitor's serial monitor takes, including
[bin2woz](https://github.com/acwright/bin2woz) output, which is only Wozmon
deposit lines:

```
?autotype=\x1b0800: A9 41 EA\r0800.0802\r
```

`\r`, `\n`, `\t`, `\\` and `\xNN` are understood written literally, character for
character the rule `6502-kim dbg` runs, so a sequence copied from one to the
other means the same thing. `\x1b` is the one you will reach for most: the splash
wants an ESC, and an `<iframe>` tag is as awkward a place to put a raw control
character as a shell argument is.

It waits for the machine to be running and for the splash to appear before
typing — reaching it costs about 1.8 M cycles, almost all of it the HD44780's
power-on ritual — and gives up waiting after twenty seconds, so custom firmware
that never puts a splash up is typed at anyway.

A frame built with `serialcard=0` has no ACIA at all, and says so in the banner
rather than typing into nowhere.

---

## Inline payloads: the `64` suffix

Both media parameters have a base64 twin — `rom64` and `bin64` — that carries the
bytes in the URL instead of naming a file to fetch:

```html
<!-- The DOCS binary counter, running on the LEDs, fetching nothing. -->
<iframe src="…/embed.html?bin64=$0800=ZDalNo0AlKkyogAgdaDmNoDw&accessory=led-latch&keys=ESC,UP"></iframe>
```

This is the form to reach for on a documentation site. It needs no CORS headers,
no `connect-src` allowance and no second network round trip, so a code sample is
genuinely self-contained: the snippet *is* the program. A type-in card is a few
dozen bytes, which is nothing in a URL.

When both spellings are present the `64` one wins — it is already in hand — and a
warning records that the other was skipped.

Both alphabets are accepted, padded or not:

```bash
# URL-safe: paste the output straight into the URL.
base64 < counter.bin | tr '+/' '-_' | tr -d '=\n'

# Standard base64 works too — a query string turns "+" into a space, which is
# decoded back. "/" and "=" need no escaping in a query string.
base64 < counter.bin | tr -d '\n'
```

A `data:application/octet-stream;base64,…` prefix is stripped if you leave one
on, so `FileReader.readAsDataURL()` output pastes in directly.

`bin64` takes the same `<address>=<payload>` shape as `bin`, split on the *first*
`=` so base64 padding survives:

```
?bin64=$0800=qQFgAAA=
```

---

## CORS and CSP

**A relative URL is relative to this frame, not to your page.** The fetch is made
by `embed.html`, which is served from here — so `bin=$0800=counter.bin` asks for
`counter.bin` next to the emulator, not next to the page doing the framing, and
comes back 404 over an otherwise working monitor. There is no way around it from
this side: the frame cannot read its parent's address. Give a fetched file its
full `https://…` address, and if you will not know that address until after you
have uploaded, build it in the host page:

```html
<script>
  const machine = new URL('https://acwright.github.io/6502-KIMULATOR/embed.html')
  machine.searchParams.set('bin', '$0800=' + new URL('counter.bin', location.href).href)
  document.querySelector('iframe').src = machine
</script>
```

A fetched `rom` or `bin` has two further conditions on it, and both belong to the
host serving the file:

- **CORS.** A cross-origin fetch needs `Access-Control-Allow-Origin` from
  whatever serves the file. GitHub Pages and most object stores send it; a plain
  Apache directory often does not. Nothing the embed can do substitutes for it.
- **CSP.** `embed.html` sets `connect-src 'self' https:`, widened from the main
  app's `'self'` for exactly this fetch. `http:` URLs are still refused, and
  `script-src` stays `'self'` — nothing fetched can be executed as code.

If either fails, the embed reports the problem and boots anyway: a docs page with
a broken program link still shows a working KC Monitor. Use the
[`64` forms](#inline-payloads-the-64-suffix) when you want no network at all.

`frame-ancestors` is deliberately not set, and GitHub Pages sends no
`X-Frame-Options`, so framing works as shipped from any origin.

---

## Keyboard focus

The embed captures the keyboard **only after the reader clicks it**, and only
while the frame has focus. Before then, arrow keys and space scroll the host page
as usual — an emulator that ate the reader's page-down key because it happened to
be on screen would be a bad guest. (The desktop app hands the pad the keyboard as
it launches, because there the window *is* the machine.)

The click goes to the pad when the pad is shown, and to the terminal otherwise —
and clicking a panel directly gives that panel the keyboard, which is the same
click-to-focus the full app uses. `Tab` moves between them, and the small
keyboard badge in a panel's corner lights on whichever one is listening.

A prompt sits on the frame until the first click, in one of two shapes depending
on what the click will actually do:

- **`autostart=0`** — the machine is off and clicking is what starts it, so the
  prompt covers the frame and reads *Click to start*.
- **`autostart=1`** (the default) — the machine is already booting, so all the
  click can offer is the keyboard. The prompt shrinks to a corner badge saying
  so, rather than covering up the boot. Clicking anywhere in the frame works; the
  badge is only the affordance.

Use `autostart=0` when you want the machine held until the reader asks for it —
several embeds on one page all emulating a CPU nobody has looked at yet is real
work for someone's battery. `keys=` and `autotype=` both wait for the machine to
be running, so `autostart=0&keys=ESC` starts the monitor on the click rather than
before it.

---

## Sizing

There is no single raster to double here the way there is on a machine with a
video card — the KIM is four panels beside each other — so the size follows the
panels you asked for:

| `panels` | Suggested |
|---|---|
| all four (default) | 720 × 480 |
| `lcd,keys` | 360 × 520 — the pad is 4 × 6, and wants height |
| `terminal` | 480 × 400 — the tube is 4:3 |
| `lcd` | 400 × 140 |
| `lcd,accessory` | 400 × 300 |

Every panel scales to whatever box you give it and keeps its proportions: the
terminal is a 320 × 240 raster scaled up whole, the pad letterboxes, and the LCD
keeps the character area's aspect with its dot pitch snapped to whole device
pixels so the grid stays crisp at any size. For a fluid layout, wrap it:

```html
<div style="position: relative; width: 100%; max-width: 720px; aspect-ratio: 720/480">
  <iframe src="…/embed.html" style="position: absolute; inset: 0; width: 100%; height: 100%; border: 0"></iframe>
</div>
```

Add `allow="fullscreen"` if you want the fullscreen button to work; without it
the browser refuses and the embed says so. Double-clicking the LCD expands it to
fill the frame, which needs nothing.

---

## The `postMessage` API

For driving the frame after it has loaded — a "Run this" button beside a code
block, say. Everything the URL parameters do at load time, this does at any time.

Message names are prefixed `6502-kim:`, where 6502-EMULATOR's are `6502:`. The
two emulators are separate machines, and a page that frames both should not be
able to reset the wrong one by getting a target subtly wrong.

### Sending commands

```js
const frame = document.querySelector('iframe').contentWindow

frame.postMessage({ type: '6502-kim:load', kind: 'bin', address: 0x0800, data: base64 }, '*')
frame.postMessage({ type: '6502-kim:key', keys: 'ESC,0,8,0,0,UP' }, '*')
frame.postMessage({ type: '6502-kim:reset' }, '*')
```

| Message | Fields | Effect |
|---|---|---|
| `6502-kim:load` | `kind`, `data`, `address?`, `label?` | Load media. `kind` is `rom` or `bin`; `address` applies to `bin` (default `$0800`). Loading a ROM resets the CPU |
| `6502-kim:key` | `keys`, `kps?` | Press pad keys — a `'ESC,0,8'` sequence, a list, or one name. Numbers are encoder codes; strings are names |
| `6502-kim:type` | `text` | Type text down the serial line |
| `6502-kim:run` | — | Start the machine |
| `6502-kim:pause` | — | Stop it |
| `6502-kim:reset` | — | Warm reset — pulses RESET, keeps RAM |
| `6502-kim:powerCycle` | — | Cold reset — zeroes RAM |

`data` may be a base64 string, an `ArrayBuffer`, a typed array, or an array of
byte values. A string is the one that survives being written into a JSON blob or
an HTML attribute, so it is usually what you want.

**`key` and `type` are held until the machine can hear them**, so a host page may
send either the moment it gets `6502-kim:ready` without knowing that the firmware
takes about three seconds to reach its splash. Anything sent later, mid-session,
goes straight through. The four that *operate* the machine — `run`, `pause`,
`reset`, `powerCycle` — never wait, since under `autostart=0` a `run` is what
lifts the gate in the first place.

A second `6502-kim:key` takes the pad from the first rather than racing it. Two
sequences pacing themselves against one encoder would not interleave so much as
erase each other, and taking over is what a reader pressing your second button
means anyway.

Unknown `6502-kim:` verbs are ignored, for the same reason unknown URL parameters
are.

### Receiving events

```js
window.addEventListener('message', (event) => {
  if (event.source !== frame) return
  switch (event.data?.type) {
    case '6502-kim:ready':   /* the machine is up and the firmware is in */ break
    case '6502-kim:stopped': /* event.data.reason — a StopReason */        break
    case '6502-kim:serial':  /* event.data.bytes / event.data.text */      break
  }
})
```

| Message | Fields |
|---|---|
| `6502-kim:ready` | `rom`, `cardROM`, `accessory`, `serialCard`, `panels`, `controls`, `warnings` — sent once, after the boot sequence |
| `6502-kim:stopped` | `reason`, the debug protocol's `StopReason`. A program ending in `STP` arrives as `{ kind: 'trap', detail: 'stp' }` — see [DEBUG-PROTOCOL.md](DEBUG-PROTOCOL.md) |
| `6502-kim:serial` | `bytes` (numbers) and `text`, from the ACIA. Coalesced over ~32 ms rather than one message per character. Silent on a machine with `serialcard=0` |

There is no `lcd` event. The glass is on screen, and a host page that needs to
*read* it wants the debug protocol and a real machine rather than a frame — see
[DRIVING.md](DRIVING.md).

### Origins

**By default the embed accepts commands from any origin.** That is what makes a
raw `<iframe>` on someone else's CDN work with no configuration, and the exposure
is bounded: the emulator holds no credentials and cannot see the host page, so
the worst a hostile framer can do is drive the emulated machine it is already
framing.

If that is not a trade you want, name the origins that may drive it:

```
?origins=https://docs.example.com,https://staging.example.com
```

Inbound messages from anywhere else are then dropped, and outbound messages are
posted only to those origins. `origins=*` is the explicit spelling of the
default.

---

## The `embed.js` loader

Convenience only — it builds the URL and sizes the frame. A raw `<iframe>` does
the same job with no script at all.

```html
<script src="https://acwright.github.io/6502-KIMULATOR/embed.js"></script>

<div data-kim-panels="lcd,keys" data-kim-keys="ESC" data-kim-width="360" data-kim-height="520"></div>
```

Every `data-kim-<name>` attribute becomes the `<name>` URL parameter, with no
list of known names in the loader — so it keeps working against an emulator newer
than itself. The prefix is `data-kim-` rather than 6502-EMULATOR's `data-6502-`,
so a page documenting both machines can load both scripts without either
claiming the other's containers.

Five attributes are read locally instead of forwarded:

| Attribute | Default |
|---|---|
| `data-kim-width` | `720` |
| `data-kim-height` | `480` |
| `data-kim-title` | `6502 KIMulator` |
| `data-kim-allow` | `fullscreen` |
| `data-kim-class` | — (set on the generated `<iframe>`) |

Repeatable parameters cannot repeat as attributes, so `data-kim-bin` and
`data-kim-bin64` take `;`-separated specs:

```html
<div data-kim-bin="$0800=program.bin;$0900=data.bin"></div>
```

A bare `data-kim` marks a container that takes only defaults. Call
`window.mountKIMEmbeds()` to scan again after adding containers dynamically.

---

## Caveats

- **The splash waits for a key.** `keys=ESC` or `autotype=\x1b…`, or your embed
  shows `--ESC TO START--` until the reader presses something.
- **A cross-origin file needs CORS on the host serving it.** There is no
  workaround from this side; use `bin64=` instead.
- **URL length bounds the `64` forms.** A type-in card is nothing; a 32 KB BIOS
  image is about 44 K of base64 and is better fetched.
- **Fullscreen needs `allow="fullscreen"` on the `<iframe>`.**
- **The frame must not be sandboxed away from scripts** — `postMessage` control
  needs `allow-scripts`, and the keyboard needs the frame to be focusable.
- **Nothing persists.** Reloading the frame is a cold boot, every time, which is
  what switching a KIM off and on again does.

---

## See also

- [DRIVING.md](DRIVING.md) — driving a real machine from a shell or an agent
- [DEBUG-PROTOCOL.md](DEBUG-PROTOCOL.md) — stop reasons, and the full debug protocol

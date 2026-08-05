# Bundled fonts

## BebasNeue-Regular.woff2

The face the real Keypad Card is legended in, used by `Keypad.vue` and nothing
else. Bundled as a `@font-face` in `../../style.css` rather than fetched from a
CDN, so the pad renders correctly offline and inside the Electron build, where
there is no network and the CSP forbids one.

- **Source** — copied from `6502-DOCS/docs/public/fonts/BebasNeue-Regular.woff2`,
  which is where the family's docs already serve it from. Keeping one subset
  across the two projects means the pad in the emulator and the pad in the docs
  are set in the same metrics.
- **Licence** — SIL Open Font License 1.1 (Ryoichi Tsunekawa, Dharma Type).
  Redistribution in a bundled application is permitted; the font is not sold on
  its own and is not renamed.

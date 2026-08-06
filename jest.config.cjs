module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
  collectCoverage: true,
  collectCoverageFrom: [
    'src/core/**/*.ts',
    'src/debug/**/*.ts',
    'src/host/**/*.ts',
    // The parts of src/renderer with no browser in them. Named file by file
    // rather than by directory: the rest of that tree is components and
    // composables that need a window, and would report as uncovered forever.
    'src/renderer/src/embed/params.ts',
    'src/renderer/src/embed/keys.ts',
    // The terminal's control-code handling, its picture, the pad's
    // map-to-panel wiring and the accessory's lamp order. All kept out of their
    // .vue files precisely so they could be tested.
    'src/renderer/src/terminal/TerminalBuffer.ts',
    'src/renderer/src/terminal/keys.ts',
    'src/renderer/src/terminal/font.ts',
    'src/renderer/src/terminal/render.ts',
    'src/renderer/src/keypad/layout.ts',
    'src/renderer/src/accessory/leds.ts'
  ],
  moduleNameMapper: {
    '^@core/(.*)$': '<rootDir>/src/core/$1',
    '^@debug/(.*)$': '<rootDir>/src/debug/$1'
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.core.json' }]
  }
}

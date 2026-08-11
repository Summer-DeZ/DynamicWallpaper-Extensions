/** @type {import('vitest/config').UserConfig} */
module.exports = {
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    coverage: { reporter: ['text', 'html'] }
  }
};

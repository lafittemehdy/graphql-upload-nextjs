/** Selects package tests without relaxing runtime error reporting. */
import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
    },
})

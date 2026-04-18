import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    server: {
      deps: {
        // Allow vitest to handle CJS modules that use require()
        inline: ['better-sqlite3'],
      },
    },
  },
})

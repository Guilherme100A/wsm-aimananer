import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Consome o código-fonte dos pacotes @wsm/* (export condition "development") também no build.
    conditions: ['development'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.VITE_API_URL ?? 'http://localhost:3000',
    },
  },
})

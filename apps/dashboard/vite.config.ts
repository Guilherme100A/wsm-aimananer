import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// O dashboard chama a API por caminhos relativos (/api, /metrics, /health). Em dev/preview, o Vite faz proxy
// para VITE_API_URL (default http://localhost:3000); em produção, sirva o dist/ na mesma origem da API.
const target = process.env.VITE_API_URL ?? 'http://localhost:3000'
const proxy = { '/api': target, '/metrics': target, '/health': target }

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Consome o código-fonte dos pacotes @wsm/* (export condition "development") também no build.
    conditions: ['development'],
  },
  server: { port: 5173, proxy },
  preview: { proxy },
})

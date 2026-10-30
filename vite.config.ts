import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  // En desarrollo el front (5173) delega la API al backend (8787).
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
})

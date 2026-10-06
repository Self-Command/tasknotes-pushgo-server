import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../web-dist", emptyOutDir: true },
  server: { proxy: { "/tasknotes": "http://127.0.0.1:8787" } },
});

import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": resolve(import.meta.dirname, "src") }
  },
  build: {
    outDir: "../../packages/octo-harness-daemon/dist/inspect-ui",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022"
  }
});

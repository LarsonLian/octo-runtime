import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
const path = (value: string) => fileURLToPath(new URL(value, import.meta.url));
export default defineConfig({
  root: path("./web"),
  resolve: {
    alias: {
      "@": path("./web/src"),
      "@shared": path("./web/src/shared"),
      "@mininglamp-oss/octo-runtime-adapter-icons": path("./web/src/adapter-icons/index.ts")
    }
  },
  build: { outDir: path("./dist/web"), emptyOutDir: true },
  test: { environment: "happy-dom" }
});

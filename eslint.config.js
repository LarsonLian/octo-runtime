import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "coverage/**"]
  },
  {
    files: ["apps/**/*.ts", "packages/**/*.ts", "public/**/*.ts"],
    ignores: ["packages/octo-runtime-webui-extra/web/**", "packages/octo-runtime-webui-extra/vite.config.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error"
    }
  },
  {
    files: ["packages/octo-runtime-webui-extra/web/**/*.{ts,tsx}", "packages/octo-runtime-webui-extra/vite.config.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: { "@typescript-eslint/no-explicit-any": "error" }
  },
  {
    // Preserve the upstream component verbatim, including its unused presentation helpers.
    files: ["packages/octo-runtime-webui-extra/web/src/surfaces/Transcript.tsx"],
    rules: { "@typescript-eslint/no-unused-vars": "off" }
  }
);

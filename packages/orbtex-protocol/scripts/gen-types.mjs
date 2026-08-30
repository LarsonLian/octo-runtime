// 从 schema/protocol.schema.json 生成 src/generated/protocol-types.ts。
// 运行：pnpm --filter @orbtex-ai/orbtex-protocol gen（build 前自动执行）。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { compile } from "json-schema-to-typescript";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "../schema/protocol.schema.json");
const outPath = resolve(here, "../src/generated/protocol-types.ts");

const schema = JSON.parse(await readFile(schemaPath, "utf8"));

const ts = await compile(schema, schema.title ?? "OrbtexProtocolSchema", {
  // 生成 definitions 下的全部类型，即使根未引用它们。
  unreachableDefinitions: true,
  // 不给对象类型追加 [k: string]: unknown，除非 schema 显式 additionalProperties: true。
  additionalProperties: false,
  bannerComment: [
    "/* eslint-disable */",
    "/**",
    " * 本文件由 scripts/gen-types.mjs 从 schema/protocol.schema.json 自动生成。",
    " * 请勿手改；改协议请编辑 schema 后运行 `pnpm gen`。",
    " */"
  ].join("\n"),
  style: { singleQuote: false }
});

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, ts, "utf8");
console.error(`generated ${outPath}`);

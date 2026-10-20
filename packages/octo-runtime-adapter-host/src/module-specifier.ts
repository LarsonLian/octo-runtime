import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** 内部加载边界：按本机路径语义识别文件，避免把 Windows 盘符交给 ESM 当作 URL 协议。 */
export function resolveAdapterModuleSpecifier(module: string, manifestPath: string): string {
  // 相对路径属于 manifest 所在目录；包名及现有 URL 保持 Node 的解析语义。
  return module.startsWith(".") || isAbsolute(module)
    ? pathToFileURL(resolve(dirname(manifestPath), module)).href
    : module;
}

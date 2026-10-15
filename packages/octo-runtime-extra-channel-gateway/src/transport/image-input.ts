import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { IMAGE_INPUT_LIMITS, type ModelInputPart } from "@mininglamp-oss/octo-runtime-protocol";
import { parseImageDimensions } from "./api/files.js";

export class ImImageInputError extends Error {}

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function imageUrl(raw: unknown, apiUrl: string): URL {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 8192)
    throw new ImImageInputError("图片地址无效。");
  try {
    const value = raw.trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/")) return new URL(value, apiUrl);
    const path = value.replace(/^file\/(?:preview\/)?/, "");
    return new URL(`${apiUrl.replace(/\/+$/, "")}/file/${path}`);
  } catch {
    throw new ImImageInputError("图片地址无效。");
  }
}

export function imagePart(bytes: Buffer, contentType?: string): ModelInputPart {
  let mimeType: "image/png" | "image/jpeg" | "image/webp";
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    mimeType = "image/png";
    if (bytes.length < 45 || bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND")
      throw new ImImageInputError("PNG 图片已损坏或不完整。");
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    mimeType = "image/jpeg";
    if (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)
      throw new ImImageInputError("JPEG 图片已损坏或不完整。");
  } else if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    mimeType = "image/webp";
    if (
      bytes.length < 25 ||
      bytes.readUInt32LE(4) + 8 !== bytes.length ||
      !["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))
    )
      throw new ImImageInputError("WebP 图片已损坏或不完整。");
  } else throw new ImImageInputError("图片格式不支持，仅支持 PNG、JPEG、WebP。");
  if (mimeType !== "image/webp") {
    const size = parseImageDimensions(bytes, mimeType);
    if (!size || size.width < 1 || size.height < 1)
      throw new ImImageInputError("图片尺寸无效或文件已损坏。");
  }
  const declared = contentType?.split(";", 1)[0].trim().toLowerCase();
  if (
    declared?.startsWith("image/") &&
    declared !== mimeType &&
    !(declared === "image/jpg" && mimeType === "image/jpeg")
  )
    throw new ImImageInputError("图片类型与实际内容不一致。");
  if (bytes.length > IMAGE_INPUT_LIMITS.maxBytes)
    throw new ImImageInputError("图片超过 2 MiB 上限。");
  return {
    type: "image",
    mimeType,
    data: bytes.toString("base64"),
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

export async function downloadImageInput(
  rawUrl: unknown,
  apiUrl: string,
  token: string,
  signal: AbortSignal
): Promise<ModelInputPart[]> {
  const trusted = new URL(apiUrl);
  signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let url = imageUrl(rawUrl, apiUrl);
  for (let hop = 0; hop <= 3; hop++) {
    signal.throwIfAborted();
    const sameOrigin = url.origin === trusted.origin;
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          sameOrigin &&
          trusted.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw new ImImageInputError("图片地址不符合下载要求。");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true });
    signal.throwIfAborted();
    if (
      !addresses.length ||
      (!sameOrigin &&
        addresses.some(({ address, family }) =>
          family === 4 ? blocked.check(address, "ipv4") : !globalV6.check(address, "ipv6")
        ))
    )
      throw new ImImageInputError("图片地址不可访问。");
    // DNS 校验结果固定到本次连接，重定向逐跳重新校验且不跨源发送 Bot 凭据。
    const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          signal,
          headers: sameOrigin ? { Authorization: `Bearer ${token}` } : {},
          lookup: (_host, options, callback) => {
            const chosen = addresses[0];
            if (options.all) callback(null, addresses as import("node:dns").LookupAddress[]);
            else callback(null, chosen.address, chosen.family);
          }
        },
        resolve
      );
      request.on("error", reject);
      request.end();
    });
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || hop === 3) throw new ImImageInputError("图片重定向过多或地址无效。");
      try {
        url = new URL(location, url);
      } catch {
        throw new ImImageInputError("图片重定向地址无效。");
      }
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new ImImageInputError(`图片下载失败（HTTP ${status}）。`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      if (Number(response.headers["content-length"]) > IMAGE_INPUT_LIMITS.maxBytes)
        throw new ImImageInputError("图片超过 2 MiB 上限。");
      for await (const chunk of response) {
        total += chunk.length;
        if (total > IMAGE_INPUT_LIMITS.maxBytes)
          throw new ImImageInputError("图片超过 2 MiB 上限。");
        chunks.push(chunk);
      }
      return [imagePart(Buffer.concat(chunks, total), response.headers["content-type"])];
    } finally {
      response.destroy();
    }
  }
  throw new ImImageInputError("图片下载失败。");
}

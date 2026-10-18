import type { Readable } from "node:stream";
import { streamCapacityError } from "@mininglamp-oss/octo-runtime-protocol";

/** Guard readline's partial-line buffer before it allocates an unbounded record. */
export function watchLineLimit(
  input: Readable,
  maximum: number | (() => number),
  fail: (error: Error) => void
): () => void {
  let bytes = 0,
    failed = false;
  const observe = (chunk: string | Buffer): void => {
    if (failed) return;
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    let start = 0;
    for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10, start)) {
      bytes += end - start;
      const limit = typeof maximum === "function" ? maximum() : maximum;
      if (bytes > limit) {
        failed = true;
        fail(
          streamCapacityError("PROVIDER_MESSAGE_TOO_LARGE", {
            boundary: "provider.line",
            measuredBytes: bytes,
            limitBytes: limit
          })
        );
        return;
      }
      bytes = 0;
      start = end + 1;
    }
    bytes += buffer.byteLength - start;
    const limit = typeof maximum === "function" ? maximum() : maximum;
    if (bytes > limit) {
      failed = true;
      fail(
        streamCapacityError("PROVIDER_MESSAGE_TOO_LARGE", {
          boundary: "provider.line",
          measuredBytes: bytes,
          limitBytes: limit
        })
      );
    }
  };
  input.prependListener("data", observe);
  return () => input.off("data", observe);
}

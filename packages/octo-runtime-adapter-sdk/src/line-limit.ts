import type { Readable } from "node:stream";

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
      if (bytes > (typeof maximum === "function" ? maximum() : maximum)) {
        failed = true;
        fail(
          Object.assign(new Error("STREAM_EVENT_TOO_LARGE"), { code: "STREAM_EVENT_TOO_LARGE" })
        );
        return;
      }
      bytes = 0;
      start = end + 1;
    }
    bytes += buffer.byteLength - start;
    if (bytes > (typeof maximum === "function" ? maximum() : maximum)) {
      failed = true;
      fail(Object.assign(new Error("STREAM_EVENT_TOO_LARGE"), { code: "STREAM_EVENT_TOO_LARGE" }));
    }
  };
  input.prependListener("data", observe);
  return () => input.off("data", observe);
}

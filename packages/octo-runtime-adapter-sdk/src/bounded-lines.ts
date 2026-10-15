import type { Readable } from "node:stream";

/** Bounded NDJSON receiver; discard an oversized record through its newline. */
export function readBoundedLines(
  input: Readable,
  maximum: number,
  options: {
    onLine: (line: string) => void;
    onTooLarge: () => void;
    onError: (error: Error) => void;
    onClose: () => void;
    discardTimeoutMs?: number;
  }
): () => void {
  let buffer = Buffer.alloc(0),
    size = 0,
    discarding = false,
    stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const reset = (): void => {
    size = 0;
    if (timer) clearTimeout(timer);
    timer = undefined;
    discarding = false;
  };
  const receive = (chunk: Buffer | string): void => {
    const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    let start = 0;
    while (start < data.length && !stopped) {
      const newline = data.indexOf(10, start);
      const end = newline < 0 ? data.length : newline;
      if (!discarding) {
        const length = end - start;
        if (size + length > maximum) {
          size = 0;
          buffer = Buffer.alloc(0);
          discarding = true;
          timer = setTimeout(
            () => input.destroy(new Error("RPC_OVERSIZED_RECORD_TIMEOUT")),
            options.discardTimeoutMs ?? 5000
          );
          timer.unref();
          options.onTooLarge();
        } else {
          if (size + length > buffer.length) {
            const next = Buffer.allocUnsafe(
              Math.min(maximum, Math.max(size + length, buffer.length * 2, 4096))
            );
            buffer.copy(next, 0, 0, size);
            buffer = next;
          }
          data.copy(buffer, size, start, end);
          size += length;
        }
      }
      if (newline < 0) return;
      const line = discarding ? undefined : buffer.toString("utf8", 0, size);
      reset();
      if (line !== undefined) options.onLine(line);
      start = newline + 1;
    }
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    reset();
    buffer = Buffer.alloc(0);
    input.off("data", receive);
    input.off("end", end);
    input.off("close", close);
    input.off("error", error);
  };
  const end = (): void => {
    if (!discarding && size) options.onLine(buffer.toString("utf8", 0, size));
    close();
  };
  const close = (): void => {
    if (!stopped) {
      stop();
      options.onClose();
    }
  };
  const error = (cause: Error): void => {
    if (!stopped) options.onError(cause);
    close();
  };
  input.on("data", receive);
  input.on("end", end);
  input.on("close", close);
  input.on("error", error);
  return stop;
}

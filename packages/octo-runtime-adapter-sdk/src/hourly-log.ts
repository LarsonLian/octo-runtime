import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { join } from "node:path";

export const HOURLY_LOG_MAX_BYTES = 100 * 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;

export class HourlyLogWriter {
  readonly #timer: NodeJS.Timeout;
  #closed = false;
  #fullHour: number | undefined;
  #lastCleanup: number | undefined;
  #warned = false;
  readonly #pattern: RegExp;

  constructor(
    readonly directory: string,
    readonly category: string,
    readonly options: {
      now?: () => number;
      maxBytes?: number;
      cleanupIntervalMs?: number;
      onError?: () => void;
    } = {}
  ) {
    if (!/^[a-z][a-z0-9-]*$/.test(category)) throw new TypeError("INVALID_LOG_CATEGORY");
    if (
      options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
    )
      throw new TypeError("INVALID_LOG_LIMIT");
    this.#pattern = new RegExp(`^${category}-(\\d{8}T\\d{2})\\.log(\\.lock)?$`);
    this.cleanup();
    this.#timer = setInterval(() => this.cleanup(), options.cleanupIntervalMs ?? 60_000);
    this.#timer.unref();
  }

  #hour(): number {
    return Math.floor((this.options.now?.() ?? Date.now()) / HOUR_MS);
  }

  #warn(): void {
    if (this.#warned) return;
    this.#warned = true;
    try {
      if (this.options.onError) this.options.onError();
      else process.stderr.write(`octo-runtime: unable to maintain ${this.category} log\n`);
    } catch {
      /* Diagnostics are best effort. */
    }
  }

  cleanup(): boolean {
    if (this.#closed) return false;
    const hour = this.#hour();
    let success = true;
    try {
      if (existsSync(this.directory)) {
        const directoryStat = lstatSync(this.directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
          throw new Error("LOG_DIRECTORY_NOT_REGULAR");
        const directory = opendirSync(this.directory);
        try {
          for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            const match = this.#pattern.exec(entry.name);
            if (!match || !entry.isFile() || entry.isSymbolicLink()) continue;
            const stamp = match[1];
            const timestamp = Date.parse(
              `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9)}:00:00Z`
            );
            const bucket = Math.floor(timestamp / HOUR_MS);
            if (Number.isFinite(bucket) && bucket >= hour - 2 && bucket <= hour) continue;
            try {
              unlinkSync(join(this.directory, entry.name));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") success = false;
            }
          }
        } finally {
          directory.closeSync();
        }
      }
    } catch {
      success = false;
    }
    this.#lastCleanup = success ? hour : undefined;
    if (!success) this.#warn();
    return success;
  }

  write(value: string | Buffer): boolean {
    if (this.#closed) return false;
    const hour = this.#hour();
    if (this.#fullHour === hour) return false;
    const bytes = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
    const maximum = this.options.maxBytes ?? HOURLY_LOG_MAX_BYTES;
    if (bytes > maximum) {
      this.#fullHour = hour;
      return false;
    }
    if (this.#lastCleanup !== hour && !this.cleanup()) return false;
    const stamp = new Date(hour * HOUR_MS).toISOString().slice(0, 13).replace(/[-:]/g, "");
    const path = join(this.directory, `${this.category}-${stamp}.log`);
    const lock = `${path}.lock`;
    let lockFd: number | undefined, output: number | undefined;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const directoryStat = lstatSync(this.directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
        throw new Error("LOG_DIRECTORY_NOT_REGULAR");
      // An exclusive, non-waiting lock also bounds concurrent writers. A crashed
      // writer's lock conservatively disables only that hour; retention removes it.
      try {
        lockFd = openSync(lock, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
      if (this.#hour() !== hour) return false;
      if (existsSync(path) && !lstatSync(path).isFile()) throw new Error("LOG_NOT_REGULAR_FILE");
      output = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      const stat = fstatSync(output);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("LOG_NOT_REGULAR_FILE");
      if (stat.size + bytes > maximum) {
        this.#fullHour = hour;
        return false;
      }
      const buffer = typeof value === "string" ? Buffer.from(value) : value;
      let written = 0;
      while (written < buffer.length) {
        const count = writeSync(output, buffer, written, buffer.length - written);
        if (count === 0) throw new Error("LOG_SHORT_WRITE");
        written += count;
      }
      if (stat.size + bytes === maximum) this.#fullHour = hour;
      return true;
    } catch {
      this.#warn();
      return false;
    } finally {
      if (output !== undefined) {
        try {
          closeSync(output);
        } catch {
          this.#warn();
        }
      }
      if (lockFd !== undefined) {
        try {
          closeSync(lockFd);
        } catch {
          this.#warn();
        }
        try {
          unlinkSync(lock);
        } catch {
          this.#warn();
        }
      }
    }
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#timer);
  }
}

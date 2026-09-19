import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { arch, cpus, hostname, platform, release, version } from "node:os";

const DEVICE_FIELD_MAX_LENGTH = 64;
let cachedDeviceInfo: RuntimeDeviceInfo | undefined;

export interface RuntimeDeviceInfo {
  os: string;
  arch: string;
  hostname: string;
}

export interface RuntimeDeviceInfoInput {
  platform: string;
  platformRelease: string;
  platformVersion?: string;
  productVersion?: string;
  linuxPrettyName?: string;
  architecture: string;
  cpuModel?: string;
  hostname: string;
}

/** Collect display-ready, non-authoritative host metadata for Runtime registration. */
export function collectRuntimeDeviceInfo(): RuntimeDeviceInfo {
  if (cachedDeviceInfo) return { ...cachedDeviceInfo };
  const currentPlatform = platform();
  cachedDeviceInfo = formatRuntimeDeviceInfo({
    platform: currentPlatform,
    platformRelease: release(),
    platformVersion: version(),
    ...(currentPlatform === "darwin" ? { productVersion: macOSProductVersion() } : {}),
    ...(currentPlatform === "linux" ? { linuxPrettyName: linuxPrettyName() } : {}),
    architecture: arch(),
    cpuModel: cpus()[0]?.model,
    hostname: hostname()
  });
  return { ...cachedDeviceInfo };
}

/** Format injected host facts separately so every supported platform is testable. */
export function formatRuntimeDeviceInfo(input: RuntimeDeviceInfoInput): RuntimeDeviceInfo {
  const platformRelease = normalized(input.platformRelease);
  let osName: string;
  let kernel: string | undefined;

  switch (input.platform) {
    case "darwin":
      osName = input.productVersion ? `macOS ${normalized(input.productVersion)}` : "macOS";
      kernel = platformRelease ? `Darwin ${platformRelease}` : undefined;
      break;
    case "linux":
      osName = normalized(input.linuxPrettyName) || "Linux";
      kernel = platformRelease && !osName.includes(platformRelease) ? `Linux ${platformRelease}` : undefined;
      break;
    case "win32": {
      const platformVersion = normalized(input.platformVersion);
      osName = /^windows\b/i.test(platformVersion) ? platformVersion : "Windows";
      kernel = platformRelease && !osName.includes(platformRelease) ? platformRelease : undefined;
      break;
    }
    default:
      osName = normalized(String(input.platform)) || "unknown";
      kernel = platformRelease || undefined;
  }

  const architecture = normalized(input.architecture) || "unknown";
  const cpuModel = normalized(input.cpuModel);
  return {
    os: withOptionalSuffix(osName, kernel),
    arch: limited(cpuModel && cpuModel.toLowerCase() !== architecture.toLowerCase()
      ? `${architecture} / ${cpuModel}`
      : architecture),
    hostname: limited(normalized(input.hostname) || "unknown")
  };
}

function macOSProductVersion(): string | undefined {
  try {
    return execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function linuxPrettyName(): string | undefined {
  try {
    const contents = readFileSync("/etc/os-release", "utf8");
    const raw = contents.split(/\r?\n/).find(line => line.startsWith("PRETTY_NAME="))?.slice("PRETTY_NAME=".length);
    if (!raw) return undefined;
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        return JSON.parse(raw) as string;
      } catch {
        return raw.slice(1, -1);
      }
    }
    if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
    return raw;
  } catch {
    return undefined;
  }
}

function withOptionalSuffix(primary: string, suffix?: string): string {
  const normalizedPrimary = normalized(primary) || "unknown";
  const normalizedSuffix = normalized(suffix);
  if (!normalizedSuffix) return limited(normalizedPrimary);
  const wrappedSuffix = ` (${normalizedSuffix})`;
  if ([...wrappedSuffix].length >= DEVICE_FIELD_MAX_LENGTH) return limited(normalizedPrimary);
  const available = DEVICE_FIELD_MAX_LENGTH - [...wrappedSuffix].length;
  return `${limited(normalizedPrimary, available)}${wrappedSuffix}`;
}

function normalized(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function limited(value: string, maxLength = DEVICE_FIELD_MAX_LENGTH): string {
  return [...value].slice(0, maxLength).join("");
}

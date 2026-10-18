import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Read the public release package, rather than the private CLI workspace version.
const releasePackage = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
) as { version: string };
export const cliVersion = releasePackage.version;
let buildInfo: { commit?: unknown; dirty?: unknown; buildTime?: unknown } = {};
try {
  const metadata: unknown = JSON.parse(
    readFileSync(new URL("./build-info.json", import.meta.url), "utf8")
  );
  if (metadata !== null && typeof metadata === "object") buildInfo = metadata;
} catch (error) {
  if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT")
    throw error;
}
const cliCommitInfo = `commit:${typeof buildInfo.commit === "string" ? buildInfo.commit.slice(0, 12) : "unknown"}${buildInfo.dirty === true ? " (dirty)" : ""}`;
const buildTime = buildInfo.buildTime;
const validBuildTime =
  typeof buildTime === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(buildTime) &&
  Number.isFinite(Date.parse(buildTime)) &&
  new Date(buildTime).toISOString() ===
    (buildTime.includes(".") ? buildTime : buildTime.replace("Z", ".000Z"));
const cliBuildInfo = `build:${validBuildTime ? buildTime : "unknown"}`;
export const cliVersionInfo = `${cliVersion}\n${cliCommitInfo}\n${cliBuildInfo}`;

interface Command {
  description: string;
  usage?: string;
  details?: string;
  flags?: Record<string, string>;
  children?: Record<string, Command>;
}

const commands: Command = {
  description:
    "Manage the local Agent runtime, provider adapters, and background service.\nBuilt-in adapters work by default; no adapter configuration is required.",
  children: {
    adapter: {
      description: "Inspect provider adapters",
      children: {
        list: { description: "List available provider adapters" },
        probe: { description: "Check whether a provider adapter is ready", usage: "<type>" }
      }
    },
    daemon: {
      description: "Manage the background runtime service",
      children: {
        start: {
          description: "Start the service in the background",
          details: "Installs a missing current-user service and waits for local IPC readiness."
        },
        stop: { description: "Stop the background service" },
        restart: { description: "Restart the background service" },
        status: { description: "Show native service and local daemon status" },
        install: {
          description: "Install the current-user service",
          flags: {
            "--no-autostart": "Disable automatic start at login",
            "--logs-dir <path>": "Enable metadata logs in this explicit directory"
          }
        },
        uninstall: {
          description: "Stop and remove the current-user service",
          details: "Preserves Runtime Home, identity, credentials, and logs."
        },
        run: {
          description: "Run the daemon in the foreground",
          flags: {
            "--quiet": "Suppress terminal lifecycle output",
            "--logs-dir <path>": "Enable metadata logs in this explicit directory"
          }
        }
      }
    },
    doctor: {
      description: "Check local configuration, service, and daemon health",
      flags: { "--json": "Output diagnostic checks as JSON (default)" }
    },
    extraset: {
      description: "Save a complete Extra plugin configuration from stdin",
      usage: "<name> < config.json",
      details:
        "Reads {module, enabled?, config}. Saves to <home>/extras/<name>/config.json, shared by all profiles.\nRestart the daemon to apply changes. Credentials are never echoed."
    },
    extraget: {
      description: "Print a saved Extra plugin configuration as complete JSON",
      usage: "<name>",
      details:
        "Reads <home>/extras/<name>/config.json without loading the plugin; profile directories are ignored.\nPrints the configuration file path to stderr; stdout contains only JSON."
    },
    status: { description: "Show local runtime status" },
    version: { description: "Print the installed CLI version" },
    help: { description: "Help about any command", usage: "[command]" },
    playboard: {
      description: "Run a development request from stdin and stream events",
      usage: "< request.json",
      details:
        "Starts a temporary daemon using real providers. For development and integration debugging.\nUses built-in adapters by default; no adapter configuration is required.\nRequires an installed, authenticated provider. Outputs NDJSON; diagnostics go to stderr.\nDefaults: codex, current directory, approval ask, 120-second timeout.\nOverride execution settings with contexts.items. Pending interactions fail explicitly.",
      flags: { "--manifest PATH": "Optional advanced override; not required for built-in adapters" }
    }
  }
};

const globalFlags: Record<string, string> = {
  "--home PATH": "Runtime Home directory",
  "--profile NAME": "Runtime profile (default: default)",
  "--verbose": "Write detailed diagnostics to stderr"
};

for (const command of Object.values(commands.children!.daemon.children!)) {
  if (command !== commands.children!.daemon.children!.run) {
    command.flags = { ...command.flags, "--json": "Output JSON without progress messages" };
  }
}

export function commandAt(path: string[]): Command {
  let command = commands;
  for (const [index, name] of path.entries()) {
    const next = command.children?.[name];
    if (!next)
      throw new Error(
        `unknown command '${name}' for '${["octo-runtime", ...path.slice(0, index)].join(" ")}'; run octo-runtime help`
      );
    command = next;
  }
  return command;
}

function rows(entries: Record<string, string>): string {
  const width = Math.max(...Object.keys(entries).map((key) => key.length));
  return Object.entries(entries)
    .map(([key, description]) => `  ${key.padEnd(width + 2)}${description}`)
    .join("\n");
}

export function helpText(path: string[] = []): string {
  const command = commandAt(path);
  const invocation = ["octo-runtime", ...path].join(" ");
  const sections = [
    ...(path.length ? [] : [`Octo Runtime CLI (${cliVersion})\n${cliCommitInfo}\n${cliBuildInfo}`]),
    command.description,
    ...(command.details ? [command.details] : []),
    `Usage:\n  ${invocation}${command.children ? " [command]" : command.usage ? ` ${command.usage}` : ""} [flags]`,
    ...(command.children
      ? [
          `Available Commands:\n${rows(Object.fromEntries(Object.entries(command.children).map(([name, child]) => [name, child.description])))}`
        ]
      : []),
    // --manifest 保留解析和执行支持，只在开发者文档说明，不展示在普通帮助中。
    `Flags:\n${rows({ ...Object.fromEntries(Object.entries(command.flags ?? {}).filter(([flag]) => flag !== "--manifest PATH")), "-h, --help": `Help for ${invocation}`, ...(path.length ? {} : { "-v, --version": "Print the installed CLI version" }) })}`,
    `Global Flags:\n${rows(globalFlags)}`,
    ...(path[0] === "playboard"
      ? [
          `Examples:\n  # Run a minimal request with Codex (bash/zsh)\n  octo-runtime playboard <<'JSON'\n  {\n    "inputs": [{"type": "text", "text": "Reply OK"}],\n    "contexts": {"schema": "octo.context-envelope/v3", "items": []},\n    "protocol_mode": "canonical"\n  }\nJSON\n\n  # Run a saved request\n  octo-runtime playboard < request.json`,
          `Input:\n  inputs          Required ModelInputPart[] (text or image)\n  contexts        Required Context v3 envelope; empty items are valid\n  protocol_mode   native (default) or canonical\n  providerSession Optional provider binding for continuation\n  continuityMode  fresh or continue (requires providerSession)\n  sessionId       Optional caller session identity\n  agentSource     provisioned or preset`,
          `Reference:\n  ${fileURLToPath(new URL("../README.md", import.meta.url))}`
        ]
      : []),
    ...(command.children
      ? [`Use "${invocation} [command] --help" for more information about a command.`]
      : [])
  ];
  return sections.join("\n\n");
}

export function validateCommand(
  positionals: string[],
  flags: Record<string, string | boolean>
): { path: string[]; help: boolean } {
  const help = flags.help === true || positionals[0] === "help";
  const requested = positionals[0] === "help" ? positionals.slice(1) : positionals;
  const path = requested.slice(0, ["adapter", "daemon"].includes(requested[0]) ? 2 : 1);
  const command = commandAt(path);
  if (!help && ["extraset", "extraget"].includes(path[0]) && flags.profile !== undefined) {
    throw new Error(
      "Extra configuration belongs to Runtime Home; --profile is not supported for extraset or extraget"
    );
  }
  if (help && requested.length > path.length && command.children)
    throw new Error("unexpected arguments for help");
  const allowed = new Set([
    "help",
    "version",
    "home",
    "profile",
    "verbose",
    ...Object.keys(command.flags ?? {}).map((flag) =>
      flag
        .split(" ")[0]
        .slice(2)
        .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
    )
  ]);
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key) || (key === "version" && path.length))
      throw new Error(`unknown option --${key}`);
  }
  if (!help && !command.children) {
    const expected =
      ["extraset", "extraget"].includes(path[0]) || path.join(" ") === "adapter probe" ? 1 : 0;
    if (requested.length !== path.length + expected)
      throw new Error(`invalid arguments; run ${["octo-runtime", ...path, "--help"].join(" ")}`);
  }
  return { path, help: help || Boolean(command.children) };
}

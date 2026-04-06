import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

export function defaultPathForPlatform() {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem";
  }
  return "/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
}

export function ensurePathInEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (typeof env.PATH === "string" && env.PATH.length > 0) return env;
  if (typeof env.Path === "string" && env.Path.length > 0) return env;
  return { ...env, PATH: defaultPathForPlatform() };
}

/**
 * Build environment variables for agent runs.
 * Configurable prefix (defaults to "ORCHESTRATOR").
 */
export function buildAgentEnv(
  agent: { id: string; tenantId: string },
  opts?: {
    envPrefix?: string;
    apiUrl?: string;
    listenHost?: string;
    listenPort?: string;
  },
): Record<string, string> {
  const prefix = opts?.envPrefix ?? "ORCHESTRATOR";

  const resolveHostForUrl = (rawHost: string): string => {
    const host = rawHost.trim();
    if (!host || host === "0.0.0.0" || host === "::") return "localhost";
    if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]"))
      return `[${host}]`;
    return host;
  };

  const vars: Record<string, string> = {
    [`${prefix}_AGENT_ID`]: agent.id,
    [`${prefix}_COMPANY_ID`]: agent.tenantId,
  };

  const runtimeHost = resolveHostForUrl(
    opts?.listenHost ?? process.env.HOST ?? "localhost",
  );
  const runtimePort = opts?.listenPort ?? process.env.PORT ?? "3100";
  const apiUrl = opts?.apiUrl ?? `http://${runtimeHost}:${runtimePort}`;
  vars[`${prefix}_API_URL`] = apiUrl;

  return vars;
}

export async function ensureAbsoluteDirectory(
  cwd: string,
  opts: { createIfMissing?: boolean } = {},
) {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`Working directory must be an absolute path: "${cwd}"`);
  }

  const assertDirectory = async () => {
    const stats = await fs.stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: "${cwd}"`);
    }
  };

  try {
    await assertDirectory();
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!opts.createIfMissing || code !== "ENOENT") {
      if (code === "ENOENT") {
        throw new Error(`Working directory does not exist: "${cwd}"`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  try {
    await fs.mkdir(cwd, { recursive: true });
    await assertDirectory();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not create working directory "${cwd}": ${reason}`);
  }
}

async function pathExists(candidate: string) {
  try {
    await fs.access(
      candidate,
      process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

async function resolveCommandPath(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  if (hasPathSeparator) {
    const absolute = path.isAbsolute(command)
      ? command
      : path.resolve(cwd, command);
    return (await pathExists(absolute)) ? absolute : null;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  const hasExtension =
    process.platform === "win32" && path.extname(command).length > 0;

  for (const dir of dirs) {
    const candidates =
      process.platform === "win32"
        ? hasExtension
          ? [path.join(dir, command)]
          : exts.map((ext) => path.join(dir, `${command}${ext}`))
        : [path.join(dir, command)];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return candidate;
    }
  }

  return null;
}

export async function ensureCommandResolvable(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  const resolved = await resolveCommandPath(command, cwd, env);
  if (resolved) return;
  if (command.includes("/") || command.includes("\\")) {
    const absolute = path.isAbsolute(command)
      ? command
      : path.resolve(cwd, command);
    throw new Error(
      `Command is not executable: "${command}" (resolved: "${absolute}")`,
    );
  }
  throw new Error(`Command not found in PATH: "${command}"`);
}

function quoteForCmd(arg: string) {
  if (!arg.length) return '""';
  const escaped = arg.replace(/"/g, '""');
  return /[\s"&<>|^()]/.test(escaped) ? `"${escaped}"` : escaped;
}

export async function resolveSpawnTarget(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ command: string; args: string[] }> {
  const resolved = await resolveCommandPath(command, cwd, env);
  const executable = resolved ?? command;

  if (process.platform !== "win32") {
    return { command: executable, args };
  }

  if (/\.(cmd|bat)$/i.test(executable)) {
    const shell = env.ComSpec || process.env.ComSpec || "cmd.exe";
    const commandLine = [quoteForCmd(executable), ...args.map(quoteForCmd)].join(
      " ",
    );
    return {
      command: shell,
      args: ["/d", "/s", "/c", commandLine],
    };
  }

  return { command: executable, args };
}

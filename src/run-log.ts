import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  RunLogger,
  RunLogHandle,
  RunLogReadOptions,
  RunLogReadResult,
  RunLogFinalizeSummary,
} from "./interfaces/logger.js";

function safeSegments(...segments: string[]) {
  return segments.map((segment) =>
    segment.replace(/[^a-zA-Z0-9._-]/g, "_"),
  );
}

function resolveWithin(basePath: string, relativePath: string) {
  const resolved = path.resolve(basePath, relativePath);
  const base = path.resolve(basePath) + path.sep;
  if (!resolved.startsWith(base) && resolved !== path.resolve(basePath)) {
    throw new Error("Invalid log path");
  }
  return resolved;
}

/**
 * Default NDJSON run log writer — stores logs as files on local disk.
 * Adapted from Paperclip's run-log-store.ts.
 */
export class DefaultRunLogger implements RunLogger {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  async begin(input: {
    tenantId: string;
    agentId: string;
    runId: string;
  }): Promise<RunLogHandle> {
    const [tenantId, agentId] = safeSegments(input.tenantId, input.agentId);
    const runId = safeSegments(input.runId)[0]!;
    const relDir = path.join(tenantId!, agentId!);
    const relPath = path.join(relDir, `${runId}.ndjson`);

    const dir = resolveWithin(this.basePath, relDir);
    await fs.mkdir(dir, { recursive: true });

    const absPath = resolveWithin(this.basePath, relPath);
    await fs.writeFile(absPath, "", "utf8");

    return { store: "local_file", logRef: relPath };
  }

  async append(
    handle: RunLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
  ): Promise<void> {
    if (handle.store !== "local_file") return;
    const absPath = resolveWithin(this.basePath, handle.logRef);
    const line = JSON.stringify({
      ts: event.ts,
      stream: event.stream,
      chunk: event.chunk,
    });
    await fs.appendFile(absPath, `${line}\n`, "utf8");
  }

  async finalize(handle: RunLogHandle): Promise<RunLogFinalizeSummary> {
    if (handle.store !== "local_file") {
      return { bytes: 0, compressed: false };
    }
    const absPath = resolveWithin(this.basePath, handle.logRef);
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat) throw new Error("Run log not found");

    const hash = await new Promise<string>((resolve, reject) => {
      const h = createHash("sha256");
      const stream = createReadStream(absPath);
      stream.on("data", (chunk) => h.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(h.digest("hex")));
    });

    return {
      bytes: stat.size,
      sha256: hash,
      compressed: false,
    };
  }

  async read(
    handle: RunLogHandle,
    opts?: RunLogReadOptions,
  ): Promise<RunLogReadResult> {
    if (handle.store !== "local_file") {
      throw new Error("Run log not found");
    }
    const absPath = resolveWithin(this.basePath, handle.logRef);
    const offset = opts?.offset ?? 0;
    const limitBytes = opts?.limitBytes ?? 256_000;

    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat) throw new Error("Run log not found");

    const start = Math.max(0, Math.min(offset, stat.size));
    const end = Math.max(start, Math.min(start + limitBytes - 1, stat.size - 1));

    if (start > end) {
      return { content: "", nextOffset: start };
    }

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(absPath, { start, end });
      stream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      });
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });

    const content = Buffer.concat(chunks).toString("utf8");
    const nextOffset = end + 1 < stat.size ? end + 1 : undefined;
    return { content, nextOffset };
  }
}

/**
 * No-op run logger that discards all log output.
 */
export class NullRunLogger implements RunLogger {
  async begin(input: {
    tenantId: string;
    agentId: string;
    runId: string;
  }): Promise<RunLogHandle> {
    return { store: "null", logRef: `${input.tenantId}/${input.agentId}/${input.runId}` };
  }
  async append(): Promise<void> {}
  async finalize(): Promise<RunLogFinalizeSummary> {
    return { bytes: 0, compressed: false };
  }
  async read(): Promise<RunLogReadResult> {
    return { content: "" };
  }
}

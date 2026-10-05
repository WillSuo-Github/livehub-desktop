import { spawn } from "node:child_process";
import { app } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface DouyinRoomData {
  id: string;
  douyinId: string;
  title: string;
  anchor: string;
  category: string;
  categoryId?: string;
  viewers: number;
  viewerLabel: string;
  cover: string;
  webUrl: string;
  status: "live" | "offline";
  flvStreamUrls: Record<string, string>;
  hlsStreamUrls: Record<string, string>;
}

export interface DouyinListResult {
  rooms: DouyinRoomData[];
  categoryCount: number;
  successfulCategories: number;
  failedCategories?: Array<{ id: string; name: string; error: string }>;
  partial: boolean;
  source: string;
  complete?: boolean;
  confirmedAbove?: number;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

// Leaf categories with the strongest rooms in the last full sync join the overview pages in each quick refresh.
const hotCategoryLimit = 24;

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
      }
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };

      if (code === 0) {
        resolve(result);
        return;
      }

      const details = result.stderr.trim() || `process exited with code ${code ?? signal}`;
      reject(new Error(details));
    });
  });
}

export class DouyinAdapter {
  private helperPath: string | null = null;
  private helperBuild: Promise<string> | null = null;
  private hotCategoryIds: string[] = [];

  async listFeaturedRooms(): Promise<DouyinListResult> {
    const args = ["featured", "--workers", "4"];
    if (this.hotCategoryIds.length > 0) {
      args.push("--extra", this.hotCategoryIds.join(","));
    }

    return this.invoke<DouyinListResult>(args, 75_000);
  }

  async listRooms(): Promise<DouyinListResult> {
    const result = await this.invoke<DouyinListResult>(["rooms-all", "--workers", "4"], 180_000);
    this.hotCategoryIds = rankHotCategories(result.rooms);
    return result;
  }

  private async invoke<T>(args: string[], timeoutMs = 30_000): Promise<T> {
    const helperPath = await this.ensureHelper();
    const result = await runProcess(helperPath, args, {
      cwd: getHelperDirectory(),
      timeoutMs,
    });

    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      throw new Error(`Douyin helper returned invalid JSON: ${result.stdout.slice(0, 160)}`);
    }
  }

  private async ensureHelper(): Promise<string> {
    const configuredPath = process.env.LIVEHUB_DOUYIN_HELPER;
    if (configuredPath && existsSync(configuredPath)) {
      return configuredPath;
    }

    if (this.helperPath && existsSync(this.helperPath)) {
      return this.helperPath;
    }

    const packagedHelperPath = getHelperBinaryPath();
    if (existsSync(packagedHelperPath)) {
      this.helperPath = packagedHelperPath;
      return packagedHelperPath;
    }

    if (app.isPackaged) {
      throw new Error("Packaged LiveHub is missing the Douyin helper binary.");
    }

    if (!this.helperBuild) {
      this.helperBuild = this.buildHelper();
    }

    this.helperPath = await this.helperBuild;
    return this.helperPath;
  }

  private async buildHelper(): Promise<string> {
    const helperDirectory = getHelperDirectory();
    const helperBinaryPath = getHelperBinaryPath();
    mkdirSync(path.dirname(helperBinaryPath), { recursive: true });
    await runProcess("go", ["build", "-o", helperBinaryPath, "."], {
      cwd: helperDirectory,
      timeoutMs: 120_000,
    });
    return helperBinaryPath;
  }
}

function getHelperDirectory(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "native", "douyin-helper")
    : path.resolve(__dirname, "../../native/douyin-helper");
}

function getHelperBinaryPath(): string {
  const binaryName = process.platform === "win32" ? "douyin-helper.exe" : "douyin-helper";
  return path.join(getHelperDirectory(), "bin", binaryName);
}

function rankHotCategories(rooms: DouyinRoomData[]): string[] {
  const strongestRoomByCategory = new Map<string, number>();
  for (const room of rooms) {
    if (!room.categoryId) {
      continue;
    }

    strongestRoomByCategory.set(
      room.categoryId,
      Math.max(strongestRoomByCategory.get(room.categoryId) ?? 0, room.viewers),
    );
  }

  return Array.from(strongestRoomByCategory)
    .sort((left, right) => right[1] - left[1])
    .slice(0, hotCategoryLimit)
    .map(([categoryId]) => categoryId);
}

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { mapWithConcurrency } from "./platform-http";

export interface DouyinRoomData {
  id: string;
  douyinId: string;
  title: string;
  anchor: string;
  category: string;
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
}

interface DouyinCategoryData {
  id: string;
  name: string;
}

interface DouyinCategoriesResult {
  categories: DouyinCategoryData[];
}

interface DouyinRoomsResult {
  rooms: DouyinRoomData[];
}

interface FeaturedCategoryResult {
  category: DouyinCategoryData;
  rooms: DouyinRoomData[];
  failure?: { id: string; name: string; error: string };
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

const helperDirectory = path.resolve(__dirname, "../../native/douyin-helper");
const helperBinaryDirectory = path.join(helperDirectory, "bin");
const helperBinaryName = process.platform === "win32" ? "douyin-helper.exe" : "douyin-helper";
const helperBinaryPath = path.join(helperBinaryDirectory, helperBinaryName);
const featuredCategoryLimit = 8;

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

  async listFeaturedRooms(): Promise<DouyinListResult> {
    const categoryResult = await this.invoke<DouyinCategoriesResult>(["categories"]);
    const categories = categoryResult.categories.slice(0, featuredCategoryLimit);
    const results = await mapWithConcurrency(categories, 2, async (category): Promise<FeaturedCategoryResult> => {
      try {
        const result = await this.invoke<DouyinRoomsResult>([
          "rooms",
          "--category",
          category.id,
          "--name",
          category.name,
        ]);
        return { category, rooms: result.rooms };
      } catch (error) {
        return {
          category,
          rooms: [],
          failure: {
            id: category.id,
            name: category.name,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    });
    const failedCategories = results.flatMap((result) => result.failure ? [result.failure] : []);

    return {
      rooms: dedupeRooms(results.flatMap((result) => result.rooms)),
      categoryCount: categories.length,
      successfulCategories: categories.length - failedCategories.length,
      failedCategories,
      partial: failedCategories.length > 0,
      source: "douyin-featured-categories",
    };
  }

  async listRooms(): Promise<DouyinListResult> {
    return this.invoke<DouyinListResult>(["rooms-all", "--workers", "4"], 180_000);
  }

  private async invoke<T>(args: string[], timeoutMs = 30_000): Promise<T> {
    const helperPath = await this.ensureHelper();
    const result = await runProcess(helperPath, args, {
      cwd: helperDirectory,
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

    if (existsSync(helperBinaryPath)) {
      this.helperPath = helperBinaryPath;
      return helperBinaryPath;
    }

    if (!this.helperBuild) {
      this.helperBuild = this.buildHelper();
    }

    this.helperPath = await this.helperBuild;
    return this.helperPath;
  }

  private async buildHelper(): Promise<string> {
    mkdirSync(helperBinaryDirectory, { recursive: true });
    await runProcess("go", ["build", "-o", helperBinaryPath, "."], {
      cwd: helperDirectory,
      timeoutMs: 120_000,
    });
    return helperBinaryPath;
  }
}

function dedupeRooms(rooms: DouyinRoomData[]): DouyinRoomData[] {
  return Array.from(new Map(rooms.map((room) => [room.id, room])).values())
    .sort((left, right) => right.viewers - left.viewers);
}

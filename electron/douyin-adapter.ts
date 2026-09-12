import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

interface HelperCategory {
  id: string;
  name: string;
}

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

interface HelperCategoriesResponse {
  categories: HelperCategory[];
}

interface HelperRoomsResponse {
  rooms: DouyinRoomData[];
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

const helperDirectory = path.resolve(__dirname, "../../native/douyin-helper");
const helperBinaryDirectory = path.join(helperDirectory, "bin");
const helperBinaryName = process.platform === "win32" ? "douyin-helper.exe" : "douyin-helper";
const helperBinaryPath = path.join(helperBinaryDirectory, helperBinaryName);

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
  private categoriesCache: { expiresAt: number; value: HelperCategory[] } | null = null;

  async listRooms(): Promise<{ rooms: DouyinRoomData[]; category: HelperCategory }> {
    const categories = await this.getCategories();
    const category = this.pickCategory(categories);
    const result = await this.invoke<HelperRoomsResponse>(["rooms", "--category", category.id]);

    return { rooms: result.rooms, category };
  }

  private async getCategories(): Promise<HelperCategory[]> {
    if (this.categoriesCache && this.categoriesCache.expiresAt > Date.now()) {
      return this.categoriesCache.value;
    }

    const result = await this.invoke<HelperCategoriesResponse>(["categories"]);
    if (result.categories.length === 0) {
      throw new Error("Douyin returned no live categories");
    }

    this.categoriesCache = {
      expiresAt: Date.now() + 10 * 60 * 1000,
      value: result.categories,
    };
    return result.categories;
  }

  private pickCategory(categories: HelperCategory[]): HelperCategory {
    return categories.find((category) => category.name.includes("游戏")) ?? categories[0];
  }

  private async invoke<T>(args: string[]): Promise<T> {
    const helperPath = await this.ensureHelper();
    const result = await runProcess(helperPath, args, {
      cwd: helperDirectory,
      timeoutMs: 30_000,
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

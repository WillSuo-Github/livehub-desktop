import { app } from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { StreamService } from "./stream-service";
import { browserUserAgent } from "./platform-http";
import type {
  LiveRoom,
  PlaybackUrls,
  PlayerInfo,
  PlayerResult,
  PlayerState,
} from "../shared/types";

const execFileAsync = promisify(execFile);
const settingsFileName = "player-settings.json";

type PlayerCandidate =
  | { kind: "command"; value: string }
  | { kind: "path"; value: string }
  | { kind: "app"; value: string };

interface PlayerDefinition {
  id: string;
  name: string;
  candidates: PlayerCandidate[];
}

interface ResolvedPlayer extends PlayerInfo {
  launch(url: string, options?: PlayerLaunchOptions): Promise<void>;
}

interface PlayerSettingsFile {
  defaultPlayerId?: string;
}

interface PlayerLaunchOptions {
  userAgent?: string;
  headers?: Record<string, string>;
}

interface PlayableStream {
  url: string;
  headers?: Record<string, string>;
}

const huyaPlayerLaunchOptions: PlayerLaunchOptions = {
  userAgent: browserUserAgent,
  headers: {
    Origin: "https://www.huya.com",
    Referer: "https://www.huya.com/",
  },
};

export class PlayerService {
  private playersPromise: Promise<ResolvedPlayer[]> | null = null;
  private readonly streamService = new StreamService();

  async getState(): Promise<PlayerState> {
    const players = await this.resolvePlayers();
    const settings = await this.readSettings();
    const defaultPlayerId = players.some((player) => player.id === settings.defaultPlayerId)
      ? settings.defaultPlayerId as string
      : players[0]?.id ?? "";

    if (settings.defaultPlayerId !== defaultPlayerId) {
      await this.writeSettings({ defaultPlayerId });
    }

    return {
      players: players.map(({ launch: _launch, ...player }) => player),
      defaultPlayerId,
      scannedAt: new Date().toISOString(),
    };
  }

  async refreshPlayers(): Promise<PlayerState> {
    this.playersPromise = null;
    return this.getState();
  }

  async setDefaultPlayer(playerId: string): Promise<PlayerState> {
    const players = await this.resolvePlayers();
    if (!players.some((player) => player.id === playerId)) {
      throw new Error("选择的播放器没有在本机找到。");
    }

    await this.writeSettings({ defaultPlayerId: playerId });
    return this.getState();
  }

  async requestPlay(room: LiveRoom, playerId?: string): Promise<PlayerResult> {
    const players = await this.resolvePlayers();
    const state = await this.getState();
    const player = players.find((item) => item.id === (playerId ?? state.defaultPlayerId))
      ?? players.find((item) => item.id === state.defaultPlayerId);

    if (!player) {
      return { ok: false, message: "没有找到可用的播放器。" };
    }

    let playback = room.playback;
    try {
      playback = await this.streamService.resolve(room);
    } catch (error) {
      if (!getPlayableStream(playback)) {
        return {
          ok: false,
          message: `${platformLabel(room.platform)}直连流解析失败：${shortError(error)}，未打开网页。`,
        };
      }
    }

    const stream = getPlayableStream(playback);
    if (!stream) {
      return { ok: false, message: `${platformLabel(room.platform)}暂时没有可播放的直连流，未打开网页。` };
    }

    try {
      await player.launch(stream.url, getPlayerLaunchOptions(room, stream.headers));
      return {
        ok: true,
        url: stream.url,
        message: `已使用 ${player.name} 打开直播流。`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `${player.name} 启动失败：${message.slice(0, 140)}` };
    }
  }

  private async resolvePlayers(): Promise<ResolvedPlayer[]> {
    if (!this.playersPromise) {
      this.playersPromise = this.scanPlayers();
    }
    return this.playersPromise;
  }

  private async scanPlayers(): Promise<ResolvedPlayer[]> {
    const definitions = getPlayerDefinitions();
    const resolved = await Promise.all(definitions.map((definition) => resolvePlayer(definition)));
    return resolved.flatMap((player) => player ? [player] : []);
  }

  private async readSettings(): Promise<PlayerSettingsFile> {
    try {
      const content = await fs.readFile(getSettingsPath(), "utf8");
      return JSON.parse(content) as PlayerSettingsFile;
    } catch {
      return {};
    }
  }

  private async writeSettings(settings: PlayerSettingsFile): Promise<void> {
    const settingsPath = getSettingsPath();
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }
}

async function resolvePlayer(definition: PlayerDefinition): Promise<ResolvedPlayer | null> {
  for (const candidate of definition.candidates) {
    if (candidate.kind === "command") {
      const executable = await findExecutable(candidate.value);
      if (executable) {
        return createResolvedPlayer(definition, executable, "command");
      }
      continue;
    }

    if (!existsSync(candidate.value)) {
      continue;
    }

    if (candidate.kind === "app") {
      return createResolvedPlayer(definition, candidate.value, "app");
    }

    return createResolvedPlayer(definition, candidate.value, "path");
  }

  return null;
}

function createResolvedPlayer(
  definition: PlayerDefinition,
  executable: string,
  source: "command" | "path" | "app",
): ResolvedPlayer {
  return {
    id: definition.id,
    name: definition.name,
    kind: "media",
    location: executable,
    launch: (url, options) => {
      if (definition.id === "vunio") {
        return launchVunio(executable, url, options);
      }
      if (definition.id === "iina") {
        return launchIina(executable, source, url, options);
      }
      return source === "app"
        ? launchCommand("open", ["-a", executable, url])
        : launchCommand(executable, [url]);
    },
  };
}

function launchIina(
  executable: string,
  source: PlayerCandidate["kind"],
  streamUrl: string,
  options?: PlayerLaunchOptions,
): Promise<void> {
  const iinaCli = source === "app"
    ? path.join(executable, "Contents", "MacOS", "iina-cli")
    : executable;

  if (source === "app" && !existsSync(iinaCli)) {
    return Promise.reject(new Error("IINA 应用包中没有找到 iina-cli。"));
  }

  const args = ["--no-stdin"];
  if (options?.userAgent) {
    args.push(`--mpv-user-agent=${options.userAgent}`);
  }
  const headerFields = Object.entries(options?.headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join(",");
  if (headerFields) {
    args.push(`--mpv-http-header-fields=${headerFields}`);
  }
  args.push(streamUrl);

  return launchCommand(iinaCli, args);
}

function launchVunio(
  appPath: string,
  streamUrl: string,
  options?: PlayerLaunchOptions,
): Promise<void> {
  const handoffURL = new URL("vunio://play");
  handoffURL.searchParams.set("url", streamUrl);

  const headers = { ...(options?.headers ?? {}) };
  if (options?.userAgent && !headers["User-Agent"]) {
    headers["User-Agent"] = options.userAgent;
  }
  for (const [name, value] of Object.entries(headers)) {
    handoffURL.searchParams.append("header", `${name}: ${value}`);
  }

  return launchCommand("open", ["-a", appPath, handoffURL.toString()]);
}

function getPlayerLaunchOptions(
  room: LiveRoom,
  playbackHeaders?: Record<string, string>,
): PlayerLaunchOptions | undefined {
  const baseOptions = room.platform === "huya" ? huyaPlayerLaunchOptions : undefined;
  const headers = {
    ...(baseOptions?.headers ?? {}),
    ...(playbackHeaders ?? {}),
  };
  const userAgent = playbackHeaders?.["User-Agent"] ?? baseOptions?.userAgent;

  if (!userAgent && Object.keys(headers).length === 0) {
    return undefined;
  }

  return { userAgent, headers };
}

async function findExecutable(command: string): Promise<string | null> {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  try {
    const result = await execFileAsync(lookup, [command]);
    const executable = String(result.stdout).split(/\r?\n/).map((value) => value.trim()).find(Boolean);
    return executable ?? null;
  } catch {
    return null;
  }
}

function launchCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    const handleError = (error: Error): void => {
      child.removeListener("spawn", handleSpawn);
      reject(error);
    };
    const handleSpawn = (): void => {
      child.removeListener("error", handleError);
      child.unref();
      resolve();
    };
    child.once("error", handleError);
    child.once("spawn", handleSpawn);
  });
}

function getPlayableStream(playback?: PlaybackUrls): PlayableStream | null {
  const hlsUrl = firstValue(playback?.hls);
  if (hlsUrl) {
    return { url: hlsUrl, headers: playback?.headers };
  }

  const flvUrl = firstValue(playback?.flv);
  return flvUrl ? { url: flvUrl, headers: playback?.headers } : null;
}

function platformLabel(platform: LiveRoom["platform"]): string {
  return {
    douyin: "抖音",
    douyu: "斗鱼",
    huya: "虎牙",
    bilibili: "哔哩哔哩",
  }[platform];
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 120);
}

function firstValue(values?: Record<string, string>): string | null {
  return values ? Object.values(values).find((value) => value.trim().length > 0) ?? null : null;
}

function getSettingsPath(): string {
  return path.join(app.getPath("userData"), settingsFileName);
}

function getPlayerDefinitions(): PlayerDefinition[] {
  const home = os.homedir();
  const definitions: PlayerDefinition[] = [
    {
      id: "vunio",
      name: "Vunio",
      candidates: [
        { kind: "app", value: path.join("/Applications", "Vunio.app") },
        { kind: "app", value: path.join(home, "Applications", "Vunio.app") },
      ],
    },
    {
      id: "iina",
      name: "IINA",
      candidates: [
        { kind: "command", value: "iina-cli" },
        { kind: "app", value: path.join("/Applications", "IINA.app") },
        { kind: "app", value: path.join(home, "Applications", "IINA.app") },
      ],
    },
    {
      id: "mpv",
      name: "mpv",
      candidates: [
        { kind: "command", value: "mpv" },
        { kind: "path", value: path.join("/Applications", "mpv.app", "Contents", "MacOS", "mpv") },
        { kind: "path", value: path.join(home, "Applications", "mpv.app", "Contents", "MacOS", "mpv") },
      ],
    },
    {
      id: "vlc",
      name: "VLC",
      candidates: [
        { kind: "command", value: process.platform === "win32" ? "vlc.exe" : "vlc" },
        { kind: "path", value: path.join("/Applications", "VLC.app", "Contents", "MacOS", "VLC") },
        { kind: "path", value: path.join(home, "Applications", "VLC.app", "Contents", "MacOS", "VLC") },
        { kind: "path", value: path.join(process.env.ProgramFiles ?? "", "VideoLAN", "VLC", "vlc.exe") },
        { kind: "path", value: path.join(process.env["ProgramFiles(x86)"] ?? "", "VideoLAN", "VLC", "vlc.exe") },
      ],
    },
    {
      id: "celluloid",
      name: "Celluloid",
      candidates: [{ kind: "command", value: "celluloid" }],
    },
    {
      id: "potplayer",
      name: "PotPlayer",
      candidates: [
        { kind: "command", value: "PotPlayerMini64.exe" },
        { kind: "path", value: path.join(process.env.ProgramFiles ?? "", "DAUM", "PotPlayer", "PotPlayerMini64.exe") },
        { kind: "path", value: path.join(process.env["ProgramFiles(x86)"] ?? "", "DAUM", "PotPlayer", "PotPlayerMini.exe") },
      ],
    },
    {
      id: "ffplay",
      name: "ffplay",
      candidates: [{ kind: "command", value: process.platform === "win32" ? "ffplay.exe" : "ffplay" }],
    },
  ];

  return definitions;
}

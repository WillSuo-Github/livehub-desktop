import { createServer, type Server } from "node:http";
import type { AppInfo, LiveRoom, PlatformId, PlatformRoomsUpdate, PlaybackUrls } from "../shared/types";

export const stremioPlatforms = ["douyin", "douyu", "huya", "bilibili"] as const;
const platformNames: Record<PlatformId, string> = {
  douyin: "抖音", douyu: "斗鱼", huya: "虎牙", bilibili: "哔哩哔哩",
};
const pageSize = 50;
const refreshInterval = 5 * 60_000;

interface RoomDirectory {
  listRooms(platform: PlatformId): Promise<LiveRoom[]>;
  getAppInfo(version: string): AppInfo;
  subscribe(listener: (update: PlatformRoomsUpdate) => void): () => void;
}

interface StreamResolver {
  resolve(room: LiveRoom): Promise<PlaybackUrls>;
}

class ResourceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function stremioManifest(version: string) {
  return {
    id: "com.livehub.live",
    version,
    name: "LiveHub",
    description: "Live rooms from Douyin, Douyu, Huya and Bilibili. Search indexed live rooms by title, anchor, category or room ID.",
    types: ["tv"],
    resources: ["catalog", { name: "meta", types: ["tv"], idPrefixes: ["livehub:"] },
      { name: "stream", types: ["tv"], idPrefixes: ["livehub:"] }],
    catalogs: stremioPlatforms.map((platform) => ({
      id: `livehub-${platform}`, type: "tv", name: platformNames[platform],
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }],
    })),
    behaviorHints: { configurable: false, configurationRequired: false },
  };
}

/** Directory snapshots identify rooms; playback always uses a fresh resolver request. */
export class StremioService {
  private readonly rooms = new Map<PlatformId, LiveRoom[]>();
  private readonly refreshedAt = new Map<PlatformId, number>();
  private readonly pending = new Map<PlatformId, Promise<LiveRoom[]>>();
  private readonly resolving = new Map<string, Promise<ReturnType<typeof playbackStreams>>>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly directory: RoomDirectory,
    private readonly resolver: StreamResolver,
    readonly version: string,
  ) {
    this.unsubscribe = directory.subscribe((update) => {
      if (update.status.state === "connected" && update.status.lastUpdatedAt) {
        this.rooms.set(update.platform, update.rooms);
        this.refreshedAt.set(update.platform, Date.parse(update.status.lastUpdatedAt));
      }
    });
  }

  dispose(): void { this.unsubscribe(); }

  async warmup(): Promise<void> {
    await Promise.allSettled(stremioPlatforms.map((platform) => this.loadRooms(platform)));
  }

  health() {
    const info = this.directory.getAppInfo(this.version);
    return {
      name: "LiveHub", version: this.version,
      platforms: Object.fromEntries(stremioPlatforms.map((platform) => [platform, {
        state: info[platform].state,
        rooms: this.rooms.get(platform)?.length ?? 0,
        updatedAt: info[platform].lastUpdatedAt ?? null,
        partial: info[platform].partial ?? false,
      }])),
    };
  }

  async catalog(id: string, extras: URLSearchParams) {
    const platform = stremioPlatforms.find((value) => id === `livehub-${value}`);
    if (!platform) throw new ResourceError(404, "Unknown catalog");
    const skipValue = extras.get("skip") ?? "0";
    if (!/^\d{1,7}$/.test(skipValue)) throw new ResourceError(400, "Invalid pagination offset");
    const search = normalize(extras.get("search") ?? "");
    if (search.length > 256) throw new ResourceError(400, "Search is too long");
    const skip = Number(skipValue);
    const rooms = await this.loadRooms(platform);
    const filtered = rooms.filter((room) => room.status === "live" && (!search
      || normalize([room.id, room.webUrl, room.title, room.anchor, room.category, ...room.tags].join(" ")).includes(search)));
    return { metas: filtered.slice(skip, skip + pageSize).map(roomMetadata) };
  }

  async metadata(id: string) { return { meta: roomMetadata(await this.room(id)) }; }

  async streams(id: string) {
    const room = await this.room(id);
    let pending = this.resolving.get(id);
    if (!pending) {
      if (this.resolving.size >= 4) throw new ResourceError(503, "Too many concurrent stream lookups; try again");
      pending = this.resolver.resolve(room).then((playback) => {
        const streams = playbackStreams(playback, room);
        if (!streams.length) throw new ResourceError(502, "The platform returned no playable streams");
        return streams;
      }).finally(() => this.resolving.delete(id));
      this.resolving.set(id, pending);
    }
    // Only concurrent requests share a lookup. Every subsequent play resolves fresh URLs.
    return { streams: await pending };
  }

  private async room(id: string): Promise<LiveRoom> {
    const match = /^livehub:(douyin|douyu|huya|bilibili)-[A-Za-z0-9_-]{1,100}$/.exec(id);
    if (!match) throw new ResourceError(404, "Unknown room");
    const rooms = await this.loadRooms(match[1] as PlatformId);
    const room = rooms.find((value) => `livehub:${value.id}` === id && value.status === "live");
    if (!room) throw new ResourceError(404, "Room is no longer in the live directory; refresh the catalog");
    return room;
  }

  private async loadRooms(platform: PlatformId): Promise<LiveRoom[]> {
    const cached = this.rooms.get(platform);
    if (cached && Date.now() - (this.refreshedAt.get(platform) ?? 0) < refreshInterval) return cached;
    let pending = this.pending.get(platform);
    if (!pending) {
      pending = this.directory.listRooms(platform).then((rooms) => {
        const status = this.directory.getAppInfo(this.version)[platform];
        if (status.state === "error" && !rooms.length) {
          throw new ResourceError(502, `${platform} directory is unavailable; try again`);
        }
        this.rooms.set(platform, rooms);
        this.refreshedAt.set(platform, Date.now());
        return rooms;
      }).finally(() => this.pending.delete(platform));
      this.pending.set(platform, pending);
    }
    return pending;
  }
}

function normalize(value: string): string { return value.normalize("NFKC").trim().toLocaleLowerCase(); }

function roomMetadata(room: LiveRoom) {
  // Desktop cards store a CSS background; the protocol needs only its image URL.
  const match = /^url\(("(?:[^"\\]|\\.)*")\)/.exec(room.cover);
  let poster: string | undefined;
  try { poster = httpURL(match ? JSON.parse(match[1]) : room.cover); } catch { /* No artwork. */ }
  return {
    id: `livehub:${room.id}`, type: "tv", name: `${room.anchor} · ${room.title}`,
    poster, posterShape: "landscape",
    description: [platformNames[room.platform], room.category, room.anchor, room.title,
      room.viewerLabel].filter(Boolean).join(" · "),
    genres: [platformNames[room.platform], room.category],
  };
}

function httpURL(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Invalid provider URL. */ }
  return undefined;
}

function playbackStreams(playback: PlaybackUrls, room: LiveRoom) {
  const seen = new Set<string>();
  const streams = [];
  for (const [format, urls] of [["FLV", playback.flv], ["HLS", playback.hls]] as const) {
    for (const [quality, value] of Object.entries(urls ?? {})) {
      const url = httpURL(value);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      streams.push({
        name: `${platformNames[room.platform]} · ${format} · ${quality}`,
        description: `${room.anchor} · ${room.title}`,
        url,
        behaviorHints: {
          notWebReady: true,
          ...(playback.headers && Object.keys(playback.headers).length
            ? { proxyHeaders: { request: playback.headers } } : {}),
        },
      });
    }
  }
  return streams;
}

/** A plain HTTP addon server; no Electron process or addon script execution is needed. */
export function createStremioServer(service: StremioService): Server {
  return createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
    if (!["GET", "HEAD"].includes(request.method ?? "")) {
      response.setHeader("Allow", "GET, HEAD, OPTIONS");
      response.writeHead(405).end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    let resource = "unknown";
    try {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      let result: unknown;
      if (path === "/" || path === "/manifest.json") {
        resource = "manifest";
        result = stremioManifest(service.version);
      } else if (path === "/health.json") {
        resource = "health";
        result = service.health();
      } else {
        const match = /^\/(catalog|meta|stream)\/tv\/([^/]+?)(?:\/([^/]+))?\.json$/.exec(path);
        if (!match) throw new ResourceError(404, "Unknown resource");
        resource = match[1];
        const id = decodeURIComponent(match[2]);
        if (resource !== "catalog" && match[3]) throw new ResourceError(400, "Unexpected resource arguments");
        if (resource === "catalog") result = await service.catalog(id, new URLSearchParams(match[3] ?? ""));
        else if (resource === "meta") result = await service.metadata(id);
        else result = await service.streams(id);
      }
      response.writeHead(200).end(request.method === "HEAD" ? undefined : JSON.stringify(result));
    } catch (error) {
      const status = error instanceof ResourceError ? error.status : error instanceof URIError ? 400 : 502;
      const message = error instanceof ResourceError ? error.message : status === 400 ? "Invalid URL encoding" : "Live platform request failed; try another room or retry";
      // Do not log resolved URLs, signatures, cookies or provider response bodies.
      console.error(`[stremio] ${resource} failed (${status}): ${message}`);
      response.writeHead(status).end(request.method === "HEAD" ? undefined : JSON.stringify({ error: message }));
    }
  });
}

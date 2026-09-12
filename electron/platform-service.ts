import { BilibiliAdapter } from "./bilibili-adapter";
import { DouyinAdapter, type DouyinRoomData } from "./douyin-adapter";
import { DouyuAdapter } from "./douyu-adapter";
import { HuyaAdapter } from "./huya-adapter";
import type { PlatformRoomData } from "./platform-adapter";
import type {
  AppInfo,
  LiveRoom,
  PlatformId,
  PlatformIntegrationStatus,
  PlayerResult,
} from "../shared/types";

const platforms: PlatformId[] = ["douyin", "douyu", "huya", "bilibili"];

export class PlatformService {
  private readonly adapters = {
    douyin: new DouyinAdapter(),
    douyu: new DouyuAdapter(),
    huya: new HuyaAdapter(),
    bilibili: new BilibiliAdapter(),
  };

  private readonly lastRooms: Record<PlatformId, LiveRoom[]> = {
    douyin: [],
    douyu: [],
    huya: [],
    bilibili: [],
  };

  private readonly statuses: Record<PlatformId, PlatformIntegrationStatus> = {
    douyin: checkingStatus("正在连接抖音…"),
    douyu: checkingStatus("正在连接斗鱼…"),
    huya: checkingStatus("正在连接虎牙…"),
    bilibili: checkingStatus("正在连接哔哩哔哩…"),
  };

  private allRoomsPromise: Promise<LiveRoom[]> | null = null;

  async listRooms(platform: PlatformId | "all" = "all"): Promise<LiveRoom[]> {
    if (platform === "all") {
      let refreshPromise = this.allRoomsPromise;
      if (!refreshPromise) {
        refreshPromise = this.loadAllRooms();
        this.allRoomsPromise = refreshPromise;
      }

      try {
        return await refreshPromise;
      } finally {
        if (this.allRoomsPromise === refreshPromise) {
          this.allRoomsPromise = null;
        }
      }
    }

    return this.loadRooms(platform);
  }

  private async loadAllRooms(): Promise<LiveRoom[]> {
    const roomGroups = await Promise.all(platforms.map((platformId) => this.loadRooms(platformId)));
    for (const [index, platformId] of platforms.entries()) {
      const status = this.statuses[platformId];
      if (status.state === "error" || (status.partial && (status.roomCount ?? 0) === 0)) {
        roomGroups[index] = await this.loadRooms(platformId);
      }
    }
    return roomGroups.flat();
  }

  async requestPlay(room: LiveRoom): Promise<PlayerResult> {
    if (!room.webUrl) {
      return {
        ok: false,
        message: "这个房间暂时没有可打开的直播页。",
      };
    }

    return {
      ok: true,
      url: room.webUrl,
      message: "正在打开平台直播页，直播流播放器桥接后续接入。",
    };
  }

  getAppInfo(version: string): AppInfo {
    return {
      version,
      demoMode: false,
      platforms,
      douyin: this.statuses.douyin,
      douyu: this.statuses.douyu,
      huya: this.statuses.huya,
      bilibili: this.statuses.bilibili,
    };
  }

  private async loadRooms(platform: PlatformId): Promise<LiveRoom[]> {
    try {
      const result = platform === "douyin"
        ? await this.adapters.douyin.listRooms()
        : await this.adapters[platform].listRooms();
      const rooms = result.rooms.map((room) => platform === "douyin"
        ? mapDouyinRoom(room as DouyinRoomData)
        : mapPlatformRoom(room, platform));
      const failedCategoryCount = result.failedCategories?.length ?? 0;
      const coverage = result.partial
        ? `，${failedCategoryCount} 个分类失败`
        : "，分类全部成功";

      this.statuses[platform] = {
        state: "connected",
        message: `已发现 ${rooms.length} 个真实房间${coverage}`,
        roomCount: rooms.length,
        categoryCount: result.categoryCount,
        successfulCategories: result.successfulCategories,
        failedCategoryCount,
        partial: result.partial,
      };
      this.lastRooms[platform] = rooms;
      return rooms;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cachedRooms = this.lastRooms[platform];
      this.statuses[platform] = {
        state: "error",
        message: cachedRooms.length > 0
          ? `本次刷新失败，继续使用上次 ${cachedRooms.length} 个房间：${message.slice(0, 96)}`
          : message.slice(0, 140),
        roomCount: cachedRooms.length || undefined,
      };
      return cachedRooms;
    }
  }
}

function checkingStatus(message: string): PlatformIntegrationStatus {
  return { state: "checking", message };
}

function mapDouyinRoom(room: DouyinRoomData): LiveRoom {
  return {
    id: `douyin-${room.id}`,
    platform: "douyin",
    title: room.title || "抖音直播",
    anchor: room.anchor || "未知主播",
    category: room.category || "直播",
    viewers: room.viewers,
    viewerLabel: room.viewerLabel || undefined,
    tags: [room.category || "直播"],
    cover: coverStyle(room.cover, "linear-gradient(135deg, #302155 0%, #7e4da6 52%, #edafd2 100%)"),
    status: room.status,
    updatedAt: "刚刚",
    demo: false,
    webUrl: room.webUrl,
    playback: {
      flv: room.flvStreamUrls,
      hls: room.hlsStreamUrls,
    },
  };
}

function mapPlatformRoom(room: PlatformRoomData, platform: Exclude<PlatformId, "douyin">): LiveRoom {
  return {
    id: room.id,
    platform,
    title: room.title,
    anchor: room.anchor,
    category: room.category,
    viewers: room.viewers,
    viewerLabel: room.viewerLabel || undefined,
    tags: [room.category],
    cover: coverStyle(room.cover, fallbackCover(platform)),
    status: room.status,
    updatedAt: "刚刚",
    demo: false,
    webUrl: room.webUrl,
  };
}

function coverStyle(cover: string, fallback: string): string {
  return cover ? `url(${JSON.stringify(cover)}) center center / cover no-repeat` : fallback;
}

function fallbackCover(platform: Exclude<PlatformId, "douyin">): string {
  const covers: Record<Exclude<PlatformId, "douyin">, string> = {
    douyu: "linear-gradient(135deg, #301b3f 0%, #b44b75 48%, #ffbc7d 100%)",
    huya: "linear-gradient(135deg, #17392f 0%, #2f9b74 50%, #c6e69b 100%)",
    bilibili: "linear-gradient(135deg, #19304a 0%, #3e8bc1 52%, #b7e5f3 100%)",
  };
  return covers[platform];
}

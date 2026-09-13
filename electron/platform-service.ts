import { BilibiliAdapter } from "./bilibili-adapter";
import { DouyinAdapter, type DouyinRoomData } from "./douyin-adapter";
import { DouyuAdapter } from "./douyu-adapter";
import { HuyaAdapter } from "./huya-adapter";
import { mapWithConcurrency } from "./platform-http";
import type { PlatformRoomData } from "./platform-adapter";
import type {
  AppInfo,
  LiveRoom,
  PlatformId,
  PlatformIntegrationStatus,
  PlatformRoomsUpdate,
  RoomsLoadMode,
  SyncTrigger,
} from "../shared/types";

const platforms: PlatformId[] = ["douyin", "douyu", "huya", "bilibili"];
const platformLabels: Record<PlatformId, string> = {
  douyin: "抖音",
  douyu: "斗鱼",
  huya: "虎牙",
  bilibili: "哔哩哔哩",
};
const featuredRefreshIntervalMs = 5 * 60 * 1000;
const fullRefreshIntervalMs = 60 * 60 * 1000;

type RoomsUpdateListener = (update: PlatformRoomsUpdate) => void;

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

  private featuredRoomsPromise: Promise<LiveRoom[]> | null = null;
  private fullSyncPromise: Promise<LiveRoom[]> | null = null;
  private featuredTimer: NodeJS.Timeout | null = null;
  private hourlyTimer: NodeJS.Timeout | null = null;
  private backgroundSyncStarted = false;
  private backgroundFullSyncEnabled = true;
  private readonly updateListeners = new Set<RoomsUpdateListener>();

  async listRooms(
    platform: PlatformId | "all" = "all",
    mode: RoomsLoadMode = "featured",
  ): Promise<LiveRoom[]> {
    const trigger: SyncTrigger = this.backgroundSyncStarted ? "manual" : "startup";

    if (mode === "full") {
      return this.startFullSync(trigger);
    }

    const rooms = platform === "all"
      ? await this.loadFeaturedRooms(trigger)
      : await this.loadRooms(platform, "featured", trigger);
    this.ensureBackgroundSync();
    return rooms;
  }

  subscribe(listener: RoomsUpdateListener): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  getBackgroundFullSyncEnabled(): boolean {
    return this.backgroundFullSyncEnabled;
  }

  setBackgroundFullSyncEnabled(enabled: boolean): void {
    if (enabled === this.backgroundFullSyncEnabled) {
      return;
    }

    this.backgroundFullSyncEnabled = enabled;
    if (!enabled) {
      if (this.hourlyTimer) {
        clearTimeout(this.hourlyTimer);
        this.hourlyTimer = null;
      }
      return;
    }

    if (this.backgroundSyncStarted) {
      void this.startFullSync("manual")
        .catch(() => undefined)
        .finally(() => this.scheduleHourlySync());
    }
  }

  dispose(): void {
    if (this.featuredTimer) {
      clearTimeout(this.featuredTimer);
      this.featuredTimer = null;
    }
    if (this.hourlyTimer) {
      clearTimeout(this.hourlyTimer);
      this.hourlyTimer = null;
    }
    this.updateListeners.clear();
  }

  private async loadFeaturedRooms(trigger: SyncTrigger): Promise<LiveRoom[]> {
    let refreshPromise = this.featuredRoomsPromise;
    if (!refreshPromise) {
      refreshPromise = Promise.all(
        platforms.map((platformId) => this.loadRooms(platformId, "featured", trigger)),
      ).then((roomGroups) => roomGroups.flat());
      this.featuredRoomsPromise = refreshPromise;
    }

    try {
      return await refreshPromise;
    } finally {
      if (this.featuredRoomsPromise === refreshPromise) {
        this.featuredRoomsPromise = null;
      }
    }
  }

  private startFullSync(trigger: SyncTrigger): Promise<LiveRoom[]> {
    let refreshPromise = this.fullSyncPromise;
    if (!refreshPromise) {
      const featuredPromise = this.featuredRoomsPromise?.catch(() => []) ?? Promise.resolve([]);
      refreshPromise = featuredPromise.then(() => this.loadAllRooms(trigger));
      this.fullSyncPromise = refreshPromise;
    }

    return refreshPromise.finally(() => {
      if (this.fullSyncPromise === refreshPromise) {
        this.fullSyncPromise = null;
      }
    });
  }

  private ensureBackgroundSync(): void {
    if (this.backgroundSyncStarted) {
      return;
    }

    this.backgroundSyncStarted = true;
    this.scheduleFeaturedSync();
    if (!this.backgroundFullSyncEnabled) {
      return;
    }

    void this.startFullSync("startup")
      .catch(() => undefined)
      .finally(() => {
        if (this.backgroundFullSyncEnabled) {
          this.scheduleHourlySync();
        }
      });
  }

  private scheduleFeaturedSync(): void {
    if (this.featuredTimer) {
      clearTimeout(this.featuredTimer);
    }

    this.featuredTimer = setTimeout(() => {
      this.featuredTimer = null;
      if (this.fullSyncPromise) {
        this.scheduleFeaturedSync();
        return;
      }

      void this.loadFeaturedRooms("hourly")
        .catch(() => undefined)
        .finally(() => this.scheduleFeaturedSync());
    }, featuredRefreshIntervalMs);
  }

  private scheduleHourlySync(): void {
    if (!this.backgroundFullSyncEnabled) {
      return;
    }

    if (this.hourlyTimer) {
      clearTimeout(this.hourlyTimer);
    }

    this.hourlyTimer = setTimeout(() => {
      this.hourlyTimer = null;
      if (!this.backgroundFullSyncEnabled) {
        return;
      }

      void this.startFullSync("hourly")
        .catch(() => undefined)
        .finally(() => {
          if (this.backgroundFullSyncEnabled) {
            this.scheduleHourlySync();
          }
        });
    }, fullRefreshIntervalMs);
  }

  private async loadAllRooms(trigger: SyncTrigger): Promise<LiveRoom[]> {
    const roomGroups = await mapWithConcurrency(
      platforms,
      2,
      (platformId) => this.loadRooms(platformId, "full", trigger),
    );
    return roomGroups.flat();
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

  private async loadRooms(
    platform: PlatformId,
    mode: RoomsLoadMode,
    trigger: SyncTrigger,
  ): Promise<LiveRoom[]> {
    const currentRooms = this.lastRooms[platform];
    this.statuses[platform] = {
      ...this.statuses[platform],
      state: currentRooms.length > 0 ? "connected" : "checking",
      message: mode === "featured"
        ? `正在获取${platformLabels[platform]}热门房间…`
        : `正在后台同步${platformLabels[platform]}完整列表…`,
      roomCount: currentRooms.length || undefined,
      phase: mode === "featured" ? "featured" : "syncing",
      progress: mode === "featured" ? undefined : 0,
    };
    this.emitUpdate(platform, currentRooms, this.statuses[platform], mode, trigger);

    try {
      const result = mode === "featured"
        ? platform === "douyin"
          ? await this.adapters.douyin.listFeaturedRooms()
          : await this.adapters[platform].listFeaturedRooms()
        : platform === "douyin"
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
        message: mode === "featured"
          ? `已发现 ${rooms.length} 个热门房间${coverage}`
          : `完整同步 ${rooms.length} 个真实房间${coverage}`,
        roomCount: rooms.length,
        categoryCount: result.categoryCount,
        successfulCategories: result.successfulCategories,
        failedCategoryCount,
        partial: result.partial,
        phase: mode === "featured" ? "featured" : "ready",
        progress: mode === "featured" ? undefined : 1,
        lastUpdatedAt: new Date().toISOString(),
        source: result.source,
      };
      this.lastRooms[platform] = rooms;
      this.emitUpdate(platform, rooms, this.statuses[platform], mode, trigger);
      return rooms;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retainedRooms = this.lastRooms[platform];
      this.statuses[platform] = {
        state: "error",
        message: retainedRooms.length > 0
          ? `本次刷新失败，暂保留当前 ${retainedRooms.length} 个房间：${message.slice(0, 96)}`
          : message.slice(0, 140),
        roomCount: retainedRooms.length || undefined,
        phase: "error",
        lastUpdatedAt: this.statuses[platform].lastUpdatedAt,
        source: this.statuses[platform].source,
      };
      this.emitUpdate(platform, retainedRooms, this.statuses[platform], mode, trigger);
      return retainedRooms;
    }
  }

  private emitUpdate(
    platform: PlatformId,
    rooms: LiveRoom[],
    status: PlatformIntegrationStatus,
    mode: RoomsLoadMode,
    trigger: SyncTrigger,
  ): void {
    const update: PlatformRoomsUpdate = { platform, rooms, status, mode, trigger };
    for (const listener of this.updateListeners) {
      listener(update);
    }
  }
}

function checkingStatus(message: string): PlatformIntegrationStatus {
  return { state: "checking", message, phase: "featured" };
}

function mapDouyinRoom(room: DouyinRoomData): LiveRoom {
  return {
    id: `douyin-${room.id}`,
    platform: "douyin",
    title: room.title || "抖音直播",
    anchor: room.anchor || "未知主播",
    category: room.category || "直播",
    viewers: room.viewers,
    audienceMetric: "platform-online",
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
    audienceMetric: platform === "huya" || platform === "douyu" ? "heat" : "online",
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

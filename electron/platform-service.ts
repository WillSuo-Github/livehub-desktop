import { demoRooms } from "./demo-data";
import { DouyinAdapter, type DouyinRoomData } from "./douyin-adapter";
import type {
  AppInfo,
  DouyinIntegrationStatus,
  LiveRoom,
  PlatformId,
  PlayerResult,
} from "../shared/types";

const platforms: PlatformId[] = ["douyin", "douyu", "huya", "bilibili"];

export class PlatformService {
  private readonly douyin = new DouyinAdapter();
  private douyinStatus: DouyinIntegrationStatus = {
    state: "checking",
    message: "正在连接抖音…",
  };

  async listRooms(platform: PlatformId | "all" = "all"): Promise<LiveRoom[]> {
    if (platform === "douyin") {
      return this.loadDouyinRooms();
    }

    if (platform === "all") {
      const douyinRooms = await this.loadDouyinRooms();
      return [...douyinRooms, ...demoRooms.filter((room) => room.platform !== "douyin")];
    }

    return demoRooms.filter((room) => room.platform === platform);
  }

  async requestPlay(room: LiveRoom): Promise<PlayerResult> {
    if (room.demo) {
      return {
        ok: false,
        message: "当前是演示数据，等平台解析器接入后就可以播放啦。",
      };
    }

    return {
      ok: false,
      message: "抖音直播数据已经接入，播放器桥接将在下一步接上。",
    };
  }

  getAppInfo(version: string): AppInfo {
    return {
      version,
      demoMode: true,
      platforms,
      douyin: this.douyinStatus,
    };
  }

  private async loadDouyinRooms(): Promise<LiveRoom[]> {
    try {
      const result = await this.douyin.listRooms();
      this.douyinStatus = {
        state: "connected",
        message: `已获取 ${result.rooms.length} 个真实房间`,
        categoryName: result.category.name,
      };
      return result.rooms.map(mapDouyinRoom);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.douyinStatus = {
        state: "error",
        message: message.slice(0, 140),
      };
      return [];
    }
  }
}

function mapDouyinRoom(room: DouyinRoomData): LiveRoom {
  const fallbackCover = "linear-gradient(135deg, #302155 0%, #7e4da6 52%, #edafd2 100%)";
  const cover = room.cover
    ? `url(${JSON.stringify(room.cover)}) center center / cover no-repeat`
    : fallbackCover;

  return {
    id: `douyin-${room.id}`,
    platform: "douyin",
    title: room.title || "抖音直播",
    anchor: room.anchor || "未知主播",
    category: room.category || "直播",
    viewers: room.viewers,
    viewerLabel: room.viewerLabel || undefined,
    tags: [room.category || "直播"],
    cover,
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

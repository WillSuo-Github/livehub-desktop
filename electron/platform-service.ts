import { demoRooms } from "./demo-data";
import type { LiveRoom, PlatformId, PlayerResult } from "../shared/types";

const platforms: PlatformId[] = ["douyin", "douyu", "huya", "bilibili"];

export class PlatformService {
  async listRooms(platform: PlatformId | "all" = "all"): Promise<LiveRoom[]> {
    if (platform === "all") {
      return demoRooms;
    }

    return demoRooms.filter((room) => room.platform === platform);
  }

  async requestPlay(room: LiveRoom): Promise<PlayerResult> {
    if (room.demo || !room.url) {
      return {
        ok: false,
        message: "当前是演示数据，等平台解析器接入后就可以播放啦。",
      };
    }

    return {
      ok: true,
      message: "已准备好播放链接。",
      url: room.url,
    };
  }

  getPlatforms(): PlatformId[] {
    return platforms;
  }
}

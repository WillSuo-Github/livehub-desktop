import { cleanText, fetchJson, fetchText, mapWithConcurrency, toNumber } from "./platform-http";
import type {
  PlatformCategoryFailure,
  PlatformListResult,
  PlatformRoomData,
} from "./platform-adapter";

const categoryPages = ["https://www.huya.com/g", "https://www.huya.com/"];
const listUrl = "https://www.huya.com/cache.php";
const requestHeaders = {
  Referer: "https://www.huya.com/",
};
const pageSize = 120;
const maxPagesPerCategory = 200;
const featuredCategoryLimit = 8;

interface HuyaRoom {
  gameFullName?: string;
  gameHostName?: string;
  totalCount?: string | number;
  roomName?: string;
  screenshot?: string;
  privateHost?: string;
  nick?: string;
  avatar180?: string;
  introduction?: string;
  profileRoom?: string;
  channel?: string;
  liveChannel?: string;
}

interface HuyaListResponse {
  status: number;
  message?: string;
  data?: {
    page?: number;
    pageSize?: number;
    totalPage?: number;
    totalCount?: number;
    datas?: HuyaRoom[];
  };
}

interface HuyaCategory {
  id: string;
  name: string;
}

interface CategoryResult {
  rooms: PlatformRoomData[];
  failure?: PlatformCategoryFailure;
}

export class HuyaAdapter {
  async listFeaturedRooms(): Promise<PlatformListResult> {
    const categories = (await this.listCategories()).slice(0, featuredCategoryLimit);
    const results = await mapWithConcurrency(categories, 2, (category) => this.listCategoryRooms(category, 1));
    const failedCategories = results.flatMap((result) => result.failure ? [result.failure] : []);

    return {
      rooms: dedupeRooms(results.flatMap((result) => result.rooms)),
      categoryCount: categories.length,
      successfulCategories: categories.length - failedCategories.length,
      failedCategories,
      partial: failedCategories.length > 0,
      source: "huya-featured-games",
    };
  }

  async listRooms(): Promise<PlatformListResult> {
    const categories = await this.listCategories();
    const results = await mapWithConcurrency(categories, 2, (category) => this.listCategoryRooms(category));
    const failedCategories = results.flatMap((result) => result.failure ? [result.failure] : []);
    const rooms = dedupeRooms(results.flatMap((result) => result.rooms));

    return {
      rooms,
      categoryCount: categories.length,
      successfulCategories: categories.length - failedCategories.length,
      failedCategories,
      partial: failedCategories.length > 0,
      source: "huya-game-aggregation",
    };
  }

  private async listCategories(): Promise<HuyaCategory[]> {
    const htmlPages = await Promise.all(categoryPages.map((url) => fetchText(url, requestHeaders)));
    const ids = new Set<string>();
    const pattern = /href=["'](?:https?:\/\/[^"']+)?\/g\/(\d+)["']/gi;

    for (const html of htmlPages) {
      for (const match of html.matchAll(pattern)) {
        ids.add(match[1]);
      }
    }

    if (ids.size === 0) {
      throw new Error("Huya category list is empty");
    }

    return Array.from(ids, (id) => ({ id, name: `分类 ${id}` }));
  }

  private async listCategoryRooms(
    category: HuyaCategory,
    pageLimit = maxPagesPerCategory,
  ): Promise<CategoryResult> {
    try {
      const rooms: PlatformRoomData[] = [];
      let totalPage = 1;

      for (let page = 1; page <= Math.min(totalPage, pageLimit); page += 1) {
        const params = new URLSearchParams({
          m: "LiveList",
          do: "getLiveListByPage",
          gameId: category.id,
          tagAll: "0",
          page: String(page),
        });
        const response = await fetchJson<HuyaListResponse>(`${listUrl}?${params}`, requestHeaders);
        if (response.status !== 200 || !response.data) {
          throw new Error(response.message || `Huya category ${category.id} request failed`);
        }

        totalPage = Math.max(1, toNumber(response.data.totalPage));
        const pageRooms = response.data.datas ?? [];
        rooms.push(...pageRooms.map((room) => mapRoom(room, category)));

        if (pageRooms.length === 0) {
          break;
        }
      }

      return { rooms };
    } catch (error) {
      return {
        rooms: [],
        failure: {
          id: category.id,
          name: category.name,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}

function mapRoom(
  room: HuyaRoom,
  category: HuyaCategory,
): PlatformRoomData {
  const id = room.profileRoom || room.privateHost || room.channel || room.liveChannel || `${category.id}-${room.nick}`;
  const viewers = toNumber(room.totalCount);

  return {
    id: `huya-${id}`,
    title: cleanText(room.introduction || room.roomName, `${cleanText(room.gameFullName, "虎牙直播")} 直播`),
    anchor: cleanText(room.nick, "未知主播"),
    category: cleanText(room.gameFullName || room.gameHostName, category.name),
    viewers,
    viewerLabel: viewers.toLocaleString("zh-CN"),
    cover: room.screenshot || room.avatar180 || "",
    webUrl: `https://www.huya.com/${id}`,
    status: "live",
  };
}

function dedupeRooms(rooms: PlatformRoomData[]): PlatformRoomData[] {
  return Array.from(new Map(rooms.map((room) => [room.id, room])).values())
    .sort((left, right) => right.viewers - left.viewers);
}

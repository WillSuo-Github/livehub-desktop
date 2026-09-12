export type PlatformId = "douyin" | "douyu" | "huya" | "bilibili";

export type RoomStatus = "live" | "offline";

export interface LiveRoom {
  id: string;
  platform: PlatformId;
  title: string;
  anchor: string;
  category: string;
  viewers: number;
  tags: string[];
  cover: string;
  status: RoomStatus;
  updatedAt: string;
  demo?: boolean;
  viewerLabel?: string;
  webUrl?: string;
  playback?: {
    flv?: Record<string, string>;
    hls?: Record<string, string>;
  };
  url?: string;
}

export interface DouyinIntegrationStatus {
  state: "checking" | "connected" | "error";
  message: string;
  roomCount?: number;
  categoryCount?: number;
  successfulCategories?: number;
  failedCategoryCount?: number;
  partial?: boolean;
}

export interface AppInfo {
  version: string;
  demoMode: boolean;
  platforms: PlatformId[];
  douyin: DouyinIntegrationStatus;
}

export interface PlayerResult {
  ok: boolean;
  message: string;
  url?: string;
}

export interface LiveHubApi {
  getRooms(platform?: PlatformId | "all"): Promise<LiveRoom[]>;
  getAppInfo(): Promise<AppInfo>;
  requestPlay(room: LiveRoom): Promise<PlayerResult>;
}

export type PlatformId = "douyin" | "douyu" | "huya" | "bilibili";

export type RoomsLoadMode = "featured" | "full";

export type SyncTrigger = "startup" | "hourly" | "manual";

export type PlayerKind = "media";

export type RoomStatus = "live" | "offline";

export type AudienceMetric = "online" | "platform-online" | "heat";

export interface LiveRoom {
  id: string;
  platform: PlatformId;
  title: string;
  anchor: string;
  category: string;
  viewers: number;
  audienceMetric?: AudienceMetric;
  tags: string[];
  cover: string;
  status: RoomStatus;
  updatedAt: string;
  demo?: boolean;
  viewerLabel?: string;
  webUrl?: string;
  playback?: PlaybackUrls;
  url?: string;
}

export interface PlatformIntegrationStatus {
  state: "checking" | "connected" | "error";
  message: string;
  roomCount?: number;
  categoryCount?: number;
  successfulCategories?: number;
  failedCategoryCount?: number;
  partial?: boolean;
  phase?: "featured" | "syncing" | "ready" | "error";
  progress?: number;
  lastUpdatedAt?: string;
  source?: string;
}

export type DouyinIntegrationStatus = PlatformIntegrationStatus;

export interface AppInfo {
  version: string;
  demoMode: boolean;
  platforms: PlatformId[];
  douyin: PlatformIntegrationStatus;
  douyu: PlatformIntegrationStatus;
  huya: PlatformIntegrationStatus;
  bilibili: PlatformIntegrationStatus;
}

export interface PlayerResult {
  ok: boolean;
  message: string;
  url?: string;
}

export interface OpenWebResult {
  ok: boolean;
  message: string;
}

export interface PlaybackUrls {
  flv?: Record<string, string>;
  hls?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface PlayerInfo {
  id: string;
  name: string;
  kind: PlayerKind;
  location?: string;
}

export interface PlayerState {
  players: PlayerInfo[];
  defaultPlayerId: string;
  scannedAt: string;
}

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  version?: string;
  percent?: number;
  message?: string;
}

export interface PlatformRoomsUpdate {
  platform: PlatformId;
  rooms: LiveRoom[];
  status: PlatformIntegrationStatus;
  mode: RoomsLoadMode;
  trigger: SyncTrigger;
}

export interface LiveHubApi {
  getRooms(platform?: PlatformId | "all", mode?: RoomsLoadMode): Promise<LiveRoom[]>;
  onRoomsUpdate(listener: (update: PlatformRoomsUpdate) => void): () => void;
  getAppInfo(): Promise<AppInfo>;
  getBackgroundFullSyncEnabled(): Promise<boolean>;
  setBackgroundFullSyncEnabled(enabled: boolean): Promise<boolean>;
  onOpenSettings(listener: () => void): () => void;
  getPlayerState(): Promise<PlayerState>;
  refreshPlayers(): Promise<PlayerState>;
  setDefaultPlayer(playerId: string): Promise<PlayerState>;
  getUpdateStatus(): Promise<UpdateStatus>;
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  checkForUpdates(): Promise<UpdateStatus>;
  installUpdate(): Promise<void>;
  requestPlay(room: LiveRoom, playerId?: string): Promise<PlayerResult>;
  openWebRoom(room: LiveRoom): Promise<OpenWebResult>;
}

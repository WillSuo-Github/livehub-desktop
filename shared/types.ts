export type PlatformId = "douyin" | "douyu" | "huya" | "bilibili";

export type RoomsLoadMode = "featured" | "full";

export type SyncTrigger = "startup" | "hourly" | "manual";

export type PlayerKind = "media";

export type DanmakuKind = "text" | "gift" | "member" | "like" | "system";

export type DanmakuKindFilter = Record<DanmakuKind, boolean>;

export interface DanmakuSender {
  id?: string;
  name: string;
  avatar?: string;
  level?: number;
}

export type DanmakuMetadataValue = string | number | boolean | null;

export interface DanmakuEvent {
  version: 1;
  id: string;
  platform: PlatformId;
  roomId: string;
  kind: DanmakuKind;
  text: string;
  sender?: DanmakuSender;
  color?: string;
  timestamp: string;
  metadata?: Record<string, DanmakuMetadataValue>;
}

export interface DanmakuHello {
  type: "hello";
  version: 1;
  platform: PlatformId;
  roomId: string;
  supported: boolean;
  message?: string;
}

export type DanmakuWireMessage = DanmakuEvent | DanmakuHello;

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
  getDanmakuKindFilter(): Promise<DanmakuKindFilter>;
  setDanmakuKindFilter(filter: DanmakuKindFilter): Promise<DanmakuKindFilter>;
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
  openVunioSite(): Promise<OpenWebResult>;
}

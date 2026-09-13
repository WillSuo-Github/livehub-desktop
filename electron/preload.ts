import { contextBridge, ipcRenderer } from "electron";
import type {
  AppInfo,
  LiveHubApi,
  LiveRoom,
  OpenWebResult,
  PlatformId,
  PlatformRoomsUpdate,
  PlayerResult,
  PlayerState,
  RoomsLoadMode,
} from "../shared/types";

const api: LiveHubApi = {
  getRooms: (
    platform: PlatformId | "all" = "all",
    mode: RoomsLoadMode = "featured",
  ): Promise<LiveRoom[]> => ipcRenderer.invoke("rooms:list", platform, mode),
  onRoomsUpdate: (listener: (update: PlatformRoomsUpdate) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, update: PlatformRoomsUpdate) => listener(update);
    ipcRenderer.on("rooms:update", handler);
    return () => ipcRenderer.removeListener("rooms:update", handler);
  },
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app:info"),
  getPlayerState: (): Promise<PlayerState> => ipcRenderer.invoke("players:state"),
  refreshPlayers: (): Promise<PlayerState> => ipcRenderer.invoke("players:refresh"),
  setDefaultPlayer: (playerId: string): Promise<PlayerState> =>
    ipcRenderer.invoke("players:default:set", playerId),
  requestPlay: (room: LiveRoom, playerId?: string): Promise<PlayerResult> =>
    ipcRenderer.invoke("player:open", room, playerId),
  openWebRoom: (room: LiveRoom): Promise<OpenWebResult> =>
    ipcRenderer.invoke("room:open-web", room),
};

contextBridge.exposeInMainWorld("livehub", api);

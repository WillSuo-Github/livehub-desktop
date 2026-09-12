import { contextBridge, ipcRenderer } from "electron";
import type {
  AppInfo,
  LiveHubApi,
  LiveRoom,
  PlatformId,
  PlayerResult,
} from "../shared/types";

const api: LiveHubApi = {
  getRooms: (platform: PlatformId | "all" = "all"): Promise<LiveRoom[]> =>
    ipcRenderer.invoke("rooms:list", platform),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app:info"),
  requestPlay: (room: LiveRoom): Promise<PlayerResult> =>
    ipcRenderer.invoke("player:open", room),
};

contextBridge.exposeInMainWorld("livehub", api);

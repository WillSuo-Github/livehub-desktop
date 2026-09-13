import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { autoUpdater } from "electron-updater";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PlayerService } from "./player-service";
import { PlatformService } from "./platform-service";
import type { LiveRoom, PlatformId, RoomsLoadMode, UpdateStatus } from "../shared/types";

const service = new PlatformService();
const playerService = new PlayerService();
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
let mainWindow: BrowserWindow | null = null;
let updateStatus: UpdateStatus = {
  state: "idle",
  currentVersion: "",
};
const appSettingsFileName = "app-settings.json";

interface AppSettings {
  backgroundFullSyncEnabled?: boolean;
}

function registerIpcHandlers(): void {
  ipcMain.handle(
    "rooms:list",
    (_event, platform: PlatformId | "all" = "all", mode: RoomsLoadMode = "featured") =>
      service.listRooms(platform, mode),
  );

  service.subscribe((update) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("rooms:update", update);
    }
  });

  ipcMain.handle("app:info", () => ({
    ...service.getAppInfo(app.getVersion()),
  }));

  ipcMain.handle("sync:background:get", () => service.getBackgroundFullSyncEnabled());
  ipcMain.handle("sync:background:set", async (_event, enabled: boolean) => {
    if (typeof enabled !== "boolean") {
      throw new Error("后台全量同步设置无效。");
    }

    service.setBackgroundFullSyncEnabled(enabled);
    await saveAppSettings({ backgroundFullSyncEnabled: enabled });
    return service.getBackgroundFullSyncEnabled();
  });

  ipcMain.handle("players:state", () => playerService.getState());
  ipcMain.handle("players:refresh", () => playerService.refreshPlayers());
  ipcMain.handle("players:default:set", (_event, playerId: string) =>
    playerService.setDefaultPlayer(playerId),
  );
  ipcMain.handle("updates:status", () => getUpdateStatus());
  ipcMain.handle("updates:check", () => checkForUpdates());
  ipcMain.handle("updates:install", () => {
    if (updateStatus.state === "downloaded") {
      autoUpdater.quitAndInstall(false, true);
    }
  });
  ipcMain.handle("player:open", (_event, room: LiveRoom, playerId?: string) =>
    playerService.requestPlay(room, playerId),
  );
  ipcMain.handle("room:open-web", async (_event, room: LiveRoom) => {
    const target = room.webUrl ?? room.url;
    if (!target) {
      return { ok: false, message: "这个直播间没有可打开的网页地址。" };
    }

    try {
      const url = new URL(target);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, message: "直播间网页地址无效。" };
      }

      await shell.openExternal(url.toString());
      return { ok: true, message: "已使用系统浏览器打开直播间。" };
    } catch {
      return { ok: false, message: "直播间网页打开失败。" };
    }
  });
}

function getUpdateStatus(): UpdateStatus {
  return {
    ...updateStatus,
    currentVersion: app.getVersion(),
  };
}

async function loadAppSettings(): Promise<void> {
  try {
    const content = await fs.readFile(getAppSettingsPath(), "utf8");
    const settings = JSON.parse(content) as AppSettings;
    if (typeof settings.backgroundFullSyncEnabled === "boolean") {
      service.setBackgroundFullSyncEnabled(settings.backgroundFullSyncEnabled);
    }
  } catch {
    // First launch or an invalid settings file keeps the default behavior.
  }
}

async function saveAppSettings(settings: AppSettings): Promise<void> {
  const settingsPath = getAppSettingsPath();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function getAppSettingsPath(): string {
  return path.join(app.getPath("userData"), appSettingsFileName);
}

function createApplicationMenu(): void {
  const openSettings: MenuItemConstructorOptions = {
    label: "设置",
    accelerator: "CommandOrControl+,",
    click: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("navigation:settings");
      }
    },
  };
  const template: MenuItemConstructorOptions[] = process.platform === "darwin"
    ? [
        {
          label: "LiveHub",
          submenu: [
            { role: "about" },
            { type: "separator" },
            openSettings,
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        { role: "editMenu" },
        { role: "windowMenu" },
      ]
    : [
        {
          label: "文件",
          submenu: [openSettings, { type: "separator" }, { role: "quit" }],
        },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
      ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function publishUpdateStatus(status: Omit<UpdateStatus, "currentVersion">): void {
  updateStatus = {
    ...status,
    currentVersion: app.getVersion(),
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("updates:status", updateStatus);
  }
}

async function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged || isDevelopment) {
    publishUpdateStatus({
      state: "not-available",
      message: "开发模式不会检查更新。",
    });
    return getUpdateStatus();
  }

  publishUpdateStatus({ state: "checking" });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    publishUpdateStatus({
      state: "error",
      message: error instanceof Error ? error.message.slice(0, 160) : "更新检查失败。",
    });
  }
  return getUpdateStatus();
}

function configureAutoUpdater(): void {
  if (!app.isPackaged || isDevelopment) {
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on("checking-for-update", () => {
    publishUpdateStatus({ state: "checking" });
  });
  autoUpdater.on("update-available", (info) => {
    publishUpdateStatus({ state: "available", version: info.version });
    void autoUpdater.downloadUpdate().catch((error: unknown) => {
      publishUpdateStatus({
        state: "error",
        version: info.version,
        message: error instanceof Error ? error.message.slice(0, 160) : "更新下载失败。",
      });
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    publishUpdateStatus({
      state: "downloading",
      version: updateStatus.version,
      percent: Math.round(progress.percent),
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    publishUpdateStatus({ state: "downloaded", version: info.version, percent: 100 });
  });
  autoUpdater.on("update-not-available", () => {
    publishUpdateStatus({ state: "not-available" });
  });
  autoUpdater.on("error", (error) => {
    publishUpdateStatus({
      state: "error",
      message: error.message.slice(0, 160),
    });
  });

  setTimeout(() => void checkForUpdates(), 4000);
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    title: "LiveHub",
    icon: getIconPath(),
    backgroundColor: "#090b10",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;

  if (isDevelopment && process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
}

app.whenReady().then(async () => {
  app.setAppUserModelId("com.willsuo.livehub");
  await loadAppSettings();
  if (process.platform === "darwin") {
    const icon = nativeImage.createFromPath(getIconPath());
    if (!icon.isEmpty()) {
      app.dock?.setIcon(icon);
    }
  }
  registerIpcHandlers();
  createApplicationMenu();
  createWindow();
  configureAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function getIconPath(): string {
  return app.isPackaged
    ? path.join(app.getAppPath(), "assets", "livehub-icon.png")
    : path.resolve(__dirname, "../assets/livehub-icon.png");
}

app.on("will-quit", () => {
  service.dispose();
});

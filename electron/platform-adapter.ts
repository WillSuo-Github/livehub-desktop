export interface PlatformRoomData {
  id: string;
  title: string;
  anchor: string;
  category: string;
  viewers: number;
  viewerLabel: string;
  cover: string;
  webUrl: string;
  status: "live" | "offline";
}

export interface PlatformCategoryFailure {
  id: string;
  name: string;
  error: string;
}

export interface PlatformListResult {
  rooms: PlatformRoomData[];
  categoryCount: number;
  successfulCategories: number;
  failedCategories: PlatformCategoryFailure[];
  partial: boolean;
  source: string;
}

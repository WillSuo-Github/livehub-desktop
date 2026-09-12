import type { LiveHubApi } from "../shared/types";

declare global {
  interface Window {
    livehub: LiveHubApi;
  }
}

export {};

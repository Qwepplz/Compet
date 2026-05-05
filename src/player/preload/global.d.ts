import type { playerApi } from "./index.js";

declare global {
  interface Window {
    playerApi: typeof playerApi;
  }
}

export {};

import type { managerApi } from "./index.js";

declare global {
  interface Window {
    managerApi: typeof managerApi;
  }
}

export {};

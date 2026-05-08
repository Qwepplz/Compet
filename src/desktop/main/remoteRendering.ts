import { app } from "electron";

export function configureRemoteDesktopRendering(): void {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-direct-composition");
  app.commandLine.appendSwitch("disable-accelerated-2d-canvas");
  app.commandLine.appendSwitch("disable-accelerated-video-decode");
  app.commandLine.appendSwitch("disable-accelerated-video-encode");
  app.commandLine.appendSwitch("disable-webgl");
  app.commandLine.appendSwitch("disable-webgl2");
  app.commandLine.appendSwitch("disable-features", "DirectComposition,DirectCompositionVideoOverlays,HardwareMediaKeyHandling,Vulkan");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
}

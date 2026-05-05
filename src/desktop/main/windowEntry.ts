import { existsSync } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";

interface DesktopWindowEntry {
  preloadPath: string;
  rendererPath: string;
  problems: string[];
}

export function resolveDesktopWindowEntry(bundleDir: string): DesktopWindowEntry {
  const preloadCandidates = [path.join(bundleDir, "../preload/index.js"), path.join(bundleDir, "../preload/index.mjs")];
  const preloadPath = preloadCandidates.find((candidate) => existsSync(candidate)) ?? preloadCandidates[0];
  const rendererPath = path.join(bundleDir, "../renderer/index.html");
  const problems: string[] = [];

  if (!existsSync(preloadPath)) problems.push(`缺少 preload 入口: ${preloadPath}`);
  if (!existsSync(rendererPath)) problems.push(`缺少 renderer 入口: ${rendererPath}`);

  return { preloadPath, rendererPath, problems };
}

export async function loadDesktopWindow(win: BrowserWindow, bundleDir: string): Promise<void> {
  const entry = resolveDesktopWindowEntry(bundleDir);
  if (entry.problems.length > 0) {
    await win.loadURL(startupFailureUrl(entry.problems));
    return;
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    try {
      await win.loadURL(process.env.ELECTRON_RENDERER_URL);
      return;
    } catch (error) {
      await win.loadURL(startupFailureUrl([`渲染器开发地址加载失败: ${process.env.ELECTRON_RENDERER_URL}`, errorMessage(error)]));
      return;
    }
  }

  try {
    await win.loadFile(entry.rendererPath);
  } catch (error) {
    await win.loadURL(startupFailureUrl([`渲染器文件加载失败: ${entry.rendererPath}`, errorMessage(error)]));
  }
}

function startupFailureUrl(problems: string[]): string {
  const items = problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join("");
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>Compet 启动失败</title>
    <style>
      body {
        margin: 0;
        font-family: "Segoe UI", sans-serif;
        background: #101418;
        color: #f5f7fa;
      }
      main {
        max-width: 720px;
        margin: 48px auto;
        padding: 24px 28px;
        background: #181d23;
        border: 1px solid #2a313a;
        border-radius: 16px;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.32);
      }
      h1 {
        margin-top: 0;
        font-size: 24px;
      }
      p {
        color: #c2cad3;
        line-height: 1.6;
      }
      ul {
        padding-left: 20px;
      }
      li {
        margin-bottom: 10px;
        line-height: 1.5;
        word-break: break-all;
      }
      code {
        color: #8fd3ff;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Compet 桌面程序启动失败</h1>
      <p>当前应用没有找到可用的桌面入口文件。请重新解压 ZIP，或重新生成打包产物后再启动。</p>
      <ul>${items}</ul>
    </main>
  </body>
</html>`)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

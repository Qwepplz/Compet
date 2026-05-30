import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";

const RUN_CSGO_ASSET_DIR = "run_csgo";

export async function installRunCsgoAssets(serverRoot: string): Promise<void> {
  const sourceDir = findBundledRunCsgoAssets();
  if (!sourceDir) throw new Error(`Missing bundled run_csgo assets: ${RUN_CSGO_ASSET_DIR}`);

  await cp(sourceDir, serverRoot, { recursive: true, force: true });
}

function findBundledRunCsgoAssets(): string | undefined {
  return buildRunCsgoAssetCandidates().find((candidate) => existsSync(candidate));
}

function buildRunCsgoAssetCandidates(): string[] {
  const cjsModuleDir = typeof __dirname === "string" ? __dirname : undefined;
  const baseDirs = [
    process.cwd(),
    process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : undefined,
    cjsModuleDir,
  ];
  const candidates: string[] = [];
  const seen = new Set<string>();

  const addCandidate = (candidate: string): void => {
    const normalized = path.normalize(candidate);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  for (const baseDir of baseDirs) {
    if (!baseDir) continue;
    for (const dir of getAncestorDirs(path.resolve(baseDir))) {
      addCandidate(path.join(dir, RUN_CSGO_ASSET_DIR));
      addCandidate(path.join(dir, "src", RUN_CSGO_ASSET_DIR));
    }
  }

  return candidates;
}

function getAncestorDirs(startDir: string): string[] {
  const dirs: string[] = [];
  let current = startDir;
  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

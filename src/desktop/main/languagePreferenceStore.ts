import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_LANGUAGE, isSupportedLanguage } from "../../language/translate.js";
import type { SupportedLanguage } from "../../language/types.js";

interface LanguagePreferenceFile {
  language?: unknown;
}

export class LanguagePreferenceStore {
  private readonly filePath: string;
  private readonly temporaryFilePath: string;
  private language: SupportedLanguage;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.temporaryFilePath = `${filePath}.tmp`;
    this.language = this.readLanguage();
  }

  load(): SupportedLanguage {
    return this.language;
  }

  save(language: SupportedLanguage): Promise<void> {
    if (!isSupportedLanguage(language)) {
      return Promise.reject(new TypeError("Unsupported language"));
    }

    const saveOperation = this.saveQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      try {
        await writeFile(
          this.temporaryFilePath,
          JSON.stringify({ language }),
          "utf8",
        );
        await rename(this.temporaryFilePath, this.filePath);
        this.language = language;
      } finally {
        await unlink(this.temporaryFilePath).catch(() => undefined);
      }
    });
    this.saveQueue = saveOperation.catch(() => undefined);
    return saveOperation;
  }

  private readLanguage(): SupportedLanguage {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as LanguagePreferenceFile;
      return isSupportedLanguage(parsed?.language) ? parsed.language : DEFAULT_LANGUAGE;
    } catch {
      return DEFAULT_LANGUAGE;
    }
  }
}

import React from "react";
import ReactDOM from "react-dom/client";
import { DEFAULT_LANGUAGE, isSupportedLanguage } from "../../../language/translate.js";
import { LanguageProvider } from "../../../language/react.js";
import type { SupportedLanguage } from "../../../language/types.js";
import { App } from "./App.js";
import { theme } from "./theme.js";
import "./styles.css";

async function loadInitialLanguage(): Promise<SupportedLanguage> {
  try {
    const language = await window.managerApi.loadLanguage();
    return isSupportedLanguage(language) ? language : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

void loadInitialLanguage().then((initialLanguage) => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <LanguageProvider
        initialLanguage={initialLanguage}
        saveLanguage={window.managerApi.saveLanguage}
        theme={theme}
        documentTitleKey="manager.window.title"
      >
        <App />
      </LanguageProvider>
    </React.StrictMode>,
  );
});

import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider } from "antd";
import zhCN from "antd/es/locale/zh_CN.js";
import type { Locale } from "antd/es/locale/index.js";
import { App } from "./App.js";
import { theme } from "./theme.js";
import "./styles.css";

const zhCNLocale = zhCN as unknown as Locale;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCNLocale} theme={theme}>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);

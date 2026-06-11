import { theme as antdTheme, type ThemeConfig } from "antd";

export const theme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    colorPrimary: "#ff5500",
    colorBgBase: "#0f0f10",
    colorTextBase: "#f5f5f5",
    borderRadius: 8,
    fontSize: 14,
  },
  components: {
    Layout: { bodyBg: "#0f0f10", headerBg: "#161616", siderBg: "#161616" },
    Card: { colorBgContainer: "#1a1a1c", colorBorderSecondary: "#2a2a2d" },
    Input: { colorBgContainer: "#141416", activeBorderColor: "#ff5500", hoverBorderColor: "#ff7a33" },
  },
};

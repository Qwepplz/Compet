import type { ThemeConfig } from "antd";

export const theme: ThemeConfig = {
  token: { colorPrimary: "#2563eb", borderRadius: 6, fontSize: 13 },
  components: {
    Layout: { headerBg: "#ffffff", siderBg: "#f8fafc" },
    Card: { borderRadiusLG: 8 },
    Table: { headerBg: "#f8fafc", cellPaddingBlock: 10 },
  },
};

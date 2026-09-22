import type { ThemeConfig } from "antd";

export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: "#0b6bcb",
    colorInfo: "#0b6bcb",
    colorSuccess: "#13a06f",
    colorWarning: "#d97706",
    colorError: "#d14343",
    colorText: "#162033",
    colorTextSecondary: "#687386",
    colorBgBase: "#f4f7fb",
    colorBorder: "#dce3ed",
    borderRadius: 8,
    borderRadiusLG: 12,
    controlHeight: 38,
    fontFamily:
      '"IBM Plex Sans", "Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    boxShadowSecondary: "0 18px 50px rgba(22, 32, 51, 0.14)",
  },
  components: {
    Button: {
      fontWeight: 600,
      primaryShadow: "0 5px 14px rgba(11, 107, 203, 0.2)",
    },
    Card: {
      headerFontSize: 16,
    },
    Menu: {
      darkItemBg: "transparent",
      darkItemColor: "#aebbd0",
      darkItemHoverBg: "rgba(255, 255, 255, 0.06)",
      darkItemSelectedBg: "#0b6bcb",
      darkItemSelectedColor: "#ffffff",
      itemBorderRadius: 8,
    },
    Table: {
      headerBg: "#f6f8fb",
      headerColor: "#536074",
      rowHoverBg: "#f8fbff",
    },
  },
};

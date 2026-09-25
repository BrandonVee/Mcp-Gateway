import { theme, type ThemeConfig } from "antd";

export const appTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: "#2f8cff",
    colorInfo: "#22d3ee",
    colorSuccess: "#20d99a",
    colorWarning: "#ffb547",
    colorError: "#ff5d73",
    colorText: "#edf5ff",
    colorTextSecondary: "#a3b4c9",
    colorBgBase: "#070b13",
    colorBgContainer: "#0d1422",
    colorBgElevated: "#111a2a",
    colorBorder: "#1c2b42",
    colorBorderSecondary: "#16243a",
    borderRadius: 8,
    borderRadiusLG: 12,
    controlHeight: 40,
    fontSize: 15,
    fontSizeSM: 13,
    lineHeight: 1.55,
    wireframe: false,
    fontFamily: 'var(--font-ui)',
    boxShadowSecondary: "0 24px 70px rgba(0, 0, 0, 0.5)",
  },
  components: {
    Button: {
      fontWeight: 600,
      primaryShadow:
        "0 0 0 1px rgba(80, 170, 255, 0.18), 0 8px 24px rgba(47, 140, 255, 0.22)",
      defaultBg: "#101a2a",
      defaultBorderColor: "#263953",
      defaultHoverBg: "#16243a",
    },
    Card: {
      colorBgContainer: "rgba(13, 20, 34, 0.92)",
      headerBg: "transparent",
      headerFontSize: 16,
    },
    Input: {
      colorBgContainer: "#0a111e",
      activeBg: "#0d1625",
      hoverBg: "#0d1625",
    },
    Menu: {
      darkItemBg: "transparent",
      darkItemColor: "#8090aa",
      darkItemHoverBg: "rgba(47, 140, 255, 0.08)",
      darkItemHoverColor: "#dceaff",
      darkItemSelectedBg: "rgba(47, 140, 255, 0.14)",
      darkItemSelectedColor: "#67c7ff",
      itemBorderRadius: 8,
    },
    Modal: {
      contentBg: "#0c1422",
      headerBg: "transparent",
    },
    Segmented: {
      itemSelectedBg: "#1a2a41",
      trackBg: "#09111d",
    },
    Table: {
      colorBgContainer: "transparent",
      headerBg: "#101a2a",
      headerColor: "#8fa0b8",
      rowHoverBg: "rgba(47, 140, 255, 0.06)",
      borderColor: "#18283f",
    },
    Tag: {
      defaultBg: "#121e30",
      defaultColor: "#9fb0c8",
    },
  },
};

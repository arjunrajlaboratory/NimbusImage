import { createVuetify } from "vuetify";
import { aliases, mdi } from "vuetify/iconsets/mdi";
import Persister from "@/store/Persister";

const vuetify = createVuetify({
  defaults: {
    VBtn: { variant: "tonal", rounded: "lg" },
    VCard: { variant: "flat", rounded: "lg" },
    VAlert: { variant: "tonal", rounded: "lg" },
    VSwitch: { color: "primary" },
    VCheckbox: { color: "primary", density: "comfortable" },
    VCheckboxBtn: { density: "comfortable" },
    VList: { density: "comfortable" },
    VListItem: { density: "comfortable" },
    VChip: { rounded: "pill" },
  },
  theme: {
    defaultTheme: Persister.get("theme", "dark") === "dark" ? "dark" : "light",
    themes: {
      dark: {
        colors: {
          background: "#08090a",
          surface: "#0f1011",
          "surface-bright": "#191a1b",
          "surface-light": "#28282c",
          primary: "#26A69A",
          secondary: "#d0d6e0",
          "on-background": "#f7f8f8",
          "on-surface": "#f7f8f8",
          "on-surface-variant": "#8a8f98",
          error: "#e5534b",
          success: "#27a644",
          warning: "#d4a72c",
          info: "#5b9bd5",
        },
      },
      light: {
        colors: {
          background: "#f7f8f8",
          surface: "#ffffff",
          "surface-bright": "#f3f4f5",
          "surface-light": "#e8e9eb",
          primary: "#26A69A",
          secondary: "#4a5568",
          "on-background": "#1a1a1a",
          "on-surface": "#1a1a1a",
          "on-surface-variant": "#6b7280",
          error: "#dc2626",
          success: "#16a34a",
          warning: "#ca8a04",
          info: "#2563eb",
        },
      },
    },
  },
  icons: {
    defaultSet: "mdi",
    aliases: {
      ...aliases,
      // Icon aliases required by @girder/components v4.0
      alert: "mdi-alert-circle",
      box_com: "mdi-package",
      chevron: "mdi-chevron-right",
      circle: "mdi-checkbox-blank-circle",
      collection: "mdi-file-tree",
      externalLink: "mdi-open-in-new",
      file: "mdi-file",
      fileMultiple: "mdi-file-multiple",
      fileNew: "mdi-file-plus",
      fileUpload: "mdi-file-upload",
      folder: "mdi-folder",
      folderMultiple: "mdi-folder-multiple",
      folderNonPublic: "mdi-folder-key",
      folderNew: "mdi-folder-plus",
      globe: "mdi-earth",
      item: "mdi-file",
      lock: "mdi-lock",
      login: "mdi-login",
      logout: "mdi-logout",
      more: "mdi-dots-horizontal",
      otp: "mdi-shield-key",
      preview: "mdi-file-find",
      search: "mdi-magnify",
      settings: "mdi-tune",
      user: "mdi-account",
      userGroup: "mdi-account-multiple",
      userHome: "mdi-home-account",
      view: "mdi-eye",
    },
    sets: { mdi },
  },
});

export default vuetify;

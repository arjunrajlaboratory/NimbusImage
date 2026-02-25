import { createVuetify } from "vuetify";
import { aliases, mdi } from "vuetify/iconsets/mdi";
import Persister from "@/store/Persister";

const vuetify = createVuetify({
  defaults: {
    VBtn: { variant: "tonal" },
    VCard: { variant: "flat" },
    VAlert: { variant: "tonal" },
    VSwitch: { color: "primary" },
    VCheckbox: { color: "primary" },
  },
  theme: {
    defaultTheme: Persister.get("theme", "dark") === "dark" ? "dark" : "light",
    themes: {
      dark: {
        colors: {
          surface: "#121212",
          primary: "#26A69A",
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

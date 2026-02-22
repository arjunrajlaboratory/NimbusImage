import { createVuetify } from "vuetify";
import Persister from "@/store/Persister";

const vuetify = createVuetify({
  theme: {
    defaultTheme:
      Persister.get("theme", "dark") === "dark" ? "dark" : "light",
  },
});

export default vuetify;

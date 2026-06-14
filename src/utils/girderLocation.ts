import { IGirderLocation } from "@/girder";
import store from "@/store";
import { logError } from "@/utils/log";

export async function getDefaultGirderLocation(): Promise<IGirderLocation | null> {
  try {
    const privateFolder = await store.api.getUserPrivateFolder();
    return privateFolder || store.girderUser;
  } catch (error) {
    logError("Failed to fetch default Girder location:", error);
    return store.girderUser;
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
}));

import main from "./index";
import projects from "./projects";
import store from "./root";
import type { IProject } from "./model";

function projectWithCollections(collectionIds: string[]): IProject {
  return {
    id: "project-1",
    name: "Project",
    description: "",
    creatorId: "user-1",
    created: "2026-07-26T00:00:00Z",
    updated: "2026-07-26T00:00:00Z",
    meta: {
      datasets: [],
      collections: collectionIds.map((collectionId) => ({
        collectionId,
        addedDate: "2026-07-26T00:00:00Z",
      })),
      metadata: {
        title: "Project",
        description: "",
        license: "CC-BY-4.0",
        keywords: [],
      },
      status: "draft",
    },
  };
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected the promise to reject, but it resolved");
}

describe("projects.addCollectionsToProject", () => {
  let originalUser: typeof main.girderUser;

  beforeEach(() => {
    originalUser = main.girderUser;
    (store.state as any).main.girderUser = {
      _id: "user-1",
      _modelType: "user",
      login: "test-user",
      firstName: "Test",
      lastName: "User",
    };
  });

  afterEach(() => {
    (store.state as any).main.girderUser = originalUser;
    vi.restoreAllMocks();
  });

  it("propagates the original batch failure through the real Vuex action", async () => {
    vi.spyOn(main.projectsAPI, "addCollectionsToProject").mockRejectedValue(
      new Error("Batch request failed"),
    );

    expect(
      await messageOf(
        projects.addCollectionsToProject({
          projectId: "project-1",
          collectionIds: ["collection-1", "collection-2"],
        }),
      ),
    ).toBe("Batch request failed");
  });

  it("rejects a response that does not confirm every requested collection", async () => {
    vi.spyOn(main.projectsAPI, "addCollectionsToProject").mockResolvedValue(
      projectWithCollections(["collection-1"]),
    );

    await expect(
      projects.addCollectionsToProject({
        projectId: "project-1",
        collectionIds: ["collection-1", "collection-2"],
      }),
    ).rejects.toThrow(
      "The project response did not confirm every selected collection.",
    );
  });
});

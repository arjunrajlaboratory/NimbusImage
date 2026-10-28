/**
 * fetchProject stale-response guard (PR #1414).
 *
 * Two refreshes of the same project can overlap (the Zenodo card refreshes
 * on a 409, on a job's terminal event and from its status poll). Without a
 * sequence guard, whichever resolves LAST commits, so an older snapshot
 * ("draft" from a finished upload) can replace a newer one ("uploading" from
 * the upload that followed). Imports the REAL projects store.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  main: {
    isLoggedIn: true,
    projectsAPI: {
      getProject: vi.fn(),
      updateProjectMetadata: vi.fn(),
      deleteProject: vi.fn(),
    },
  },
}));

vi.mock("@/store/index", () => ({ default: h.main }));
vi.mock("@/store/sync", () => ({ default: { setSaving: vi.fn() } }));
vi.mock("@/utils/log", () => ({ logError: vi.fn(), logWarning: vi.fn() }));

import projects from "@/store/projects";

function snapshot(status: string) {
  return {
    id: "p1",
    name: "Project",
    meta: { zenodo: { status } },
  } as any;
}

describe("fetchProject", () => {
  beforeEach(() => {
    // The real store is a singleton: start every case from an empty list.
    projects.setProjects([]);
  });

  it("keeps the newest snapshot when refreshes resolve out of order", async () => {
    let resolveOlder!: (p: unknown) => void;
    h.main.projectsAPI.getProject
      .mockReturnValueOnce(new Promise((r) => (resolveOlder = r)))
      .mockResolvedValueOnce(snapshot("uploading"));

    const older = projects.fetchProject("p1");
    await projects.fetchProject("p1");
    resolveOlder(snapshot("draft"));
    await older;

    const stored = projects.projects.find((p) => p.id === "p1");
    expect(stored?.meta.zenodo?.status).toBe("uploading");
  });

  it("keeps the cached object when a re-read finds no change", async () => {
    // Views watch the project object and re-initialise (forms, dataset and
    // access fetches) when it is replaced; an unchanged re-read must not.
    h.main.projectsAPI.getProject.mockResolvedValueOnce(snapshot("draft"));
    await projects.fetchProject("p1");
    const before = projects.projects.find((p) => p.id === "p1");
    h.main.projectsAPI.getProject.mockResolvedValueOnce(snapshot("draft"));

    await projects.fetchProject("p1");

    expect(projects.projects.find((p) => p.id === "p1")).toBe(before);
  });

  it("doesn't let a re-read that started before a save replace it", async () => {
    // Selecting a cached project re-reads it in the background; the user
    // can save metadata before that read returns. The older read must not
    // replace the saved project (the form would reset to the old values,
    // and saving again would write them back).
    h.main.projectsAPI.getProject.mockResolvedValueOnce(snapshot("draft"));
    await projects.fetchProject("p1");
    let resolveRead!: (p: unknown) => void;
    h.main.projectsAPI.getProject.mockReturnValueOnce(
      new Promise((r) => (resolveRead = r)),
    );
    const read = projects.fetchProject("p1");

    const saved = {
      ...snapshot("draft"),
      meta: { zenodo: { status: "draft" }, metadata: { title: "New title" } },
    };
    h.main.projectsAPI.updateProjectMetadata.mockResolvedValueOnce(saved);
    await projects.updateProjectMetadata({
      projectId: "p1",
      metadata: { title: "New title" },
    });
    resolveRead(snapshot("draft"));
    await read;

    const stored = projects.projects.find((p) => p.id === "p1") as any;
    expect(stored.meta.metadata?.title).toBe("New title");
  });

  it("doesn't bring back a project deleted while a re-read was out", async () => {
    h.main.projectsAPI.getProject.mockResolvedValueOnce(snapshot("draft"));
    await projects.fetchProject("p1");
    let resolveRead!: (p: unknown) => void;
    h.main.projectsAPI.getProject.mockReturnValueOnce(
      new Promise((r) => (resolveRead = r)),
    );
    const read = projects.fetchProject("p1");

    h.main.projectsAPI.deleteProject.mockResolvedValueOnce(undefined);
    await projects.deleteProject("p1");
    resolveRead(snapshot("draft"));
    await read;

    expect(projects.projects.find((p) => p.id === "p1")).toBeUndefined();
  });

  it("returns the stored project, not a response it discarded", async () => {
    let resolveOlder!: (p: unknown) => void;
    h.main.projectsAPI.getProject
      .mockReturnValueOnce(new Promise((r) => (resolveOlder = r)))
      .mockResolvedValueOnce(snapshot("uploading"));

    const older = projects.fetchProject("p1");
    await projects.fetchProject("p1");
    resolveOlder(snapshot("draft"));

    expect((await older)?.meta.zenodo?.status).toBe("uploading");
  });

  it("doesn't bring back a project a list refresh dropped", async () => {
    h.main.projectsAPI.getProject.mockResolvedValueOnce(snapshot("draft"));
    await projects.fetchProject("p1");
    let resolveRead!: (p: unknown) => void;
    h.main.projectsAPI.getProject.mockReturnValueOnce(
      new Promise((r) => (resolveRead = r)),
    );
    const read = projects.fetchProject("p1");

    // The list no longer has p1 (deleted or unshared elsewhere).
    projects.setProjects([]);
    resolveRead(snapshot("draft"));
    await read;

    expect(projects.projects.find((p) => p.id === "p1")).toBeUndefined();
  });
});

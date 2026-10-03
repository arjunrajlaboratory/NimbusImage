import { describe, it, expect } from "vitest";
import { normalize, rankCommands, scoreCommand } from "./scorer";
import { ICommand } from "./types";

function command(
  id: string,
  title: string,
  extra: Partial<ICommand> = {},
): ICommand {
  return { id, title, group: "Actions", run: () => {}, ...extra };
}

const COMMANDS: ICommand[] = [
  command("panel.filters", "Open Filters"),
  command("worker.cellpose", "Add tool: Cellpose-SAM…", {
    group: "Add tool",
    description: "Segment nuclei and cells with Cellpose",
  }),
  command("worker.spots", "Add tool: Piscis…", {
    group: "Add tool",
    description: "Find puncta in smFISH images",
  }),
  command("layer.dapi", "Toggle layer: DAPI", { keywords: ["nucleus"] }),
  command("tool.cells", "Use tool: Cell outlines"),
  command("export.csv", "Export annotations as CSV…", {
    keywords: ["spreadsheet", "download"],
  }),
  command("naive", "Tour: Naïve Bayes"),
];

function ids(query: string) {
  return rankCommands(COMMANDS, query).map((c) => c.id);
}

describe("command scorer", () => {
  it("normalizes case, hyphens and diacritics", () => {
    expect(normalize("Cellpose-SAM  Naïve")).toBe("cellpose sam naive");
  });

  it("ranks the worker first for its name", () => {
    expect(ids("cellpose")[0]).toBe("worker.cellpose");
  });

  it("matches a run of the title's word initials ('cs' → Cellpose-SAM)", () => {
    const cellpose = COMMANDS.find((c) => c.id === "worker.cellpose")!;
    // A bare subsequence match ("c…s") scores lower than the initials.
    const subsequenceOnly = command("x", "Classic");
    expect(scoreCommand(cellpose, "cs")).toBeGreaterThan(
      scoreCommand(subsequenceOnly, "cs"),
    );
    expect(scoreCommand(subsequenceOnly, "cs")).toBeGreaterThan(0);
  });

  it("prefers a title prefix over a word-start match", () => {
    const title = command("a", "Filters overview");
    const wordStart = command("b", "Open Filters");
    expect(scoreCommand(title, "filters")).toBeGreaterThan(
      scoreCommand(wordStart, "filters"),
    );
  });

  it("matches a description word ('segment nuclei' finds Cellpose)", () => {
    expect(ids("segment nuclei")[0]).toBe("worker.cellpose");
  });

  it("matches through a synonym (spots → puncta)", () => {
    expect(ids("spots")).toContain("worker.spots");
  });

  it("matches a keyword", () => {
    expect(ids("spreadsheet")).toEqual(["export.csv"]);
  });

  it("matches ignoring diacritics in either direction", () => {
    expect(ids("naive")).toEqual(["naive"]);
    expect(ids("naïve")).toEqual(["naive"]);
  });

  it("requires every query word to match", () => {
    expect(ids("dapi spreadsheet")).toEqual([]);
  });

  it("ranks a title hit above a description-only hit", () => {
    const inTitle = command("t", "Piscis spot finder");
    const inDescription = command("d", "Add tool: Piscis…", {
      description: "Spot finder",
    });
    expect(
      rankCommands([inDescription, inTitle], "finder").map((c) => c.id),
    ).toEqual(["t", "d"]);
  });

  it("returns nothing for an empty query and caps results", () => {
    expect(ids("   ")).toEqual([]);
    const many = Array.from({ length: 80 }, (_, i) =>
      command(`c${i}`, `Toggle layer ${i}`),
    );
    expect(rankCommands(many, "toggle", 50)).toHaveLength(50);
  });
});

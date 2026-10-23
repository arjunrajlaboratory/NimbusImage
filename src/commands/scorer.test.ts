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

  it("keeps non-Latin letters searchable (α-tubulin, µ)", () => {
    const greek = command("g", "Toggle layer: α-tubulin");
    const micro = command("m", "Scale: 5 µm");
    expect(normalize("α-Tubulin")).toBe("α tubulin");
    expect(rankCommands([greek, micro], "α").map((c) => c.id)).toEqual(["g"]);
    expect(rankCommands([greek, micro], "tubulin").map((c) => c.id)).toEqual([
      "g",
    ]);
    // The micro sign and Greek mu are the same letter after NFKD.
    expect(rankCommands([greek, micro], "μm").map((c) => c.id)).toEqual(["m"]);
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

  it("ranks a panel by its alias above titles that only mention the word", () => {
    const browser = command("panel.objects", "Open Object Browser", {
      aliases: ["objects", "object list"],
    });
    const measure = command("measure", "Measure objects…");
    const analysis = command("panel.analysis", "Open Analysis", {
      aliases: ["measurements"],
    });
    const colorBy = command("color", "Color by: Intensity measurements / Max");
    const all = [measure, colorBy, browser, analysis];
    expect(rankCommands(all, "objects")[0].id).toBe("panel.objects");
    // Alias prefix: a partly typed name still finds the panel.
    expect(rankCommands(all, "obj")[0].id).toBe("panel.objects");
    expect(rankCommands(all, "measurements")[0].id).toBe("panel.analysis");
  });

  it("ranks an exact alias above another command's title prefix", () => {
    const filters = command("panel.filters", "Open Filters", {
      aliases: ["Filters", "filter"],
    });
    const rows = Array.from({ length: 60 }, (_, i) =>
      command(`f${i}`, `Filter rows ${i}`),
    );
    expect(rankCommands([...rows, filters], "filter", 50)[0].id).toBe(
      "panel.filters",
    );
  });

  it("matches a plural query word against a singular title word", () => {
    // "tools" has no synonym, so only the singular fallback can match "Tool".
    const blob = command("tool.blob", "Use tool: Blob");
    const unrelated = command("x", "Toggle layer: DAPI");
    expect(rankCommands([unrelated, blob], "tools")).toEqual([blob]);
    // Not stripped from short words or double-s endings.
    expect(scoreCommand(command("g", "Open Glas"), "glass")).toBe(0);
  });

  it("never matches a state verb to its opposite", () => {
    // The minimap is visible, so its command reads "Hide minimap": asking to
    // show it must not find (and run) the hide.
    expect(scoreCommand(command("m", "Hide minimap"), "show minimap")).toBe(0);
    expect(scoreCommand(command("o", "Show objects"), "hide objects")).toBe(0);
  });

  it("matches a whole state verb only to a whole title word or keyword", () => {
    // Substring: "lock" inside "Unlock". Subsequence: o-p-e-n inside
    // "Close Nimbus AI panel". Word start: "unroll" inside "unrolling".
    expect(scoreCommand(command("v", "Unlock pan and zoom"), "lock pan")).toBe(
      0,
    );
    expect(scoreCommand(command("a", "Close Nimbus AI panel"), "open ai")).toBe(
      0,
    );
    expect(scoreCommand(command("u", "Stop unrolling Z"), "unroll z")).toBe(0);
    // "roll" inside "Unroll": Z is rolled up, so the command reads "Unroll Z".
    expect(scoreCommand(command("r", "Unroll Z"), "roll z")).toBe(0);
    // Exact words and keywords still match, and a partly typed verb matches
    // as usual.
    expect(
      scoreCommand(command("l", "Lock pan and zoom"), "lock"),
    ).toBeGreaterThan(0);
    expect(
      scoreCommand(
        command("k", "Open Filters", { keywords: ["show"] }),
        "show filters",
      ),
    ).toBeGreaterThan(0);
    expect(
      scoreCommand(command("s", "Show objects"), "sho obj"),
    ).toBeGreaterThan(0);
  });

  it("matches a subsequence within one title word, not across words", () => {
    // a-r-e-a scattered over "dapi … metrics … elongation".
    const elongation = command(
      "e",
      "Add filter: DAPI blob metrics / Elongation",
    );
    const area = command("a", "Add filter: DAPI blob metrics / Area");
    expect(scoreCommand(elongation, "area")).toBe(0);
    expect(rankCommands([elongation, area], "filter area")).toEqual([area]);
    // Inside one word it still works.
    expect(scoreCommand(command("t", "Open table"), "tbl")).toBeGreaterThan(0);
  });
});

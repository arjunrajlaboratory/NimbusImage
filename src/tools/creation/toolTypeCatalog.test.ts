import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildToolTypeSelection,
  buildToolTypeSubmenus,
} from "./toolTypeCatalog";

const TEMPLATES = JSON.parse(
  readFileSync(
    join(__dirname, "../../../public/config/templates.json"),
    "utf8",
  ),
);
const SHAPES = [
  { text: "Point", value: "point" },
  { text: "Blob", value: "polygon" },
];

describe("toolTypeCatalog", () => {
  it("builds worker cards from the image labels, keyed by image", () => {
    const submenus = buildToolTypeSubmenus(
      TEMPLATES,
      {
        "org/cellpose:1": {
          isAnnotationWorker: "",
          interfaceName: "Cellpose-SAM",
          interfaceCategory: "Segmentation",
          description: "Segment cells",
        },
        "org/not-annotation:1": { interfaceName: "Property only" },
      } as any,
      SHAPES,
    );
    const workers = submenus.filter((submenu) => submenu.isWorker);
    expect(workers.map((submenu) => submenu.displayName)).toEqual([
      "Segmentation",
    ]);
    expect(workers[0].items[0]).toMatchObject({
      text: "Cellpose-SAM",
      image: "org/cellpose:1",
      description: "Segment cells",
    });
  });

  it("selecting a shape card does not write into the shared template", () => {
    const submenus = buildToolTypeSubmenus(TEMPLATES, {}, SHAPES);
    const manual = submenus.find(
      (submenu) => submenu.submenuInterface.type === "annotation",
    )!;
    const idx = manual.submenuInterfaceIdx;
    const original = manual.template.interface[idx];
    const originalMeta = JSON.stringify(original.meta ?? null);

    const blob = buildToolTypeSelection({
      ...manual.items[1],
      submenu: manual,
    });
    expect(blob.template!.interface[idx].meta).toMatchObject({
      hideShape: true,
      defaultShape: "polygon",
    });
    // The shared template list is untouched, so the next card starts clean.
    expect(manual.template.interface[idx]).toBe(original);
    expect(JSON.stringify(original.meta ?? null)).toBe(originalMeta);
  });

  it("a select card consumes its submenu element and seeds its value", () => {
    const submenus = buildToolTypeSubmenus(TEMPLATES, {}, SHAPES);
    const tagging = submenus.find(
      (submenu) => submenu.template.type === "tagging",
    )!;
    const selection = buildToolTypeSelection({
      ...tagging.items[0],
      submenu: tagging,
    });
    expect(selection.template!.interface).toHaveLength(
      tagging.template.interface.length - 1,
    );
    expect(selection.defaultValues).toEqual(tagging.items[0].value);
  });
});

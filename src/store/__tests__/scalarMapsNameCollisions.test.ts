import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore } from "vuex";
import {
  Module,
  Mutation,
  VuexModule,
  getModule,
} from "vuex-module-decorators";

/**
 * Every store module here is registered with `@Module({ dynamic: true })` and
 * no `namespaced`, so vuex-module-decorators commits and dispatches by the
 * bare name and Vuex keeps ONE global handler list per name: a mutation or
 * action declared in two modules runs in both. The scalar map store's first
 * cut declared `setMaps`, `setError` and `setLoading`; committing its
 * `setMaps` also ran the main store's GeoJS `setMaps` with the scalar-map
 * payload, which threw, so every list "failed" live while every unit test
 * (one module in isolation) passed. Duplicate getters are the same trap in
 * another form: Vuex keeps the first and logs `duplicate getter key`.
 *
 * This reads the store sources, so it holds without loading the real
 * modules (which pull in the whole app).
 */

const STORE_DIR = resolve(__dirname, "..");
const SCALAR_MAPS = "scalarMaps.ts";

interface IModuleNames {
  commits: Set<string>; // mutations and actions share the problem
  getters: Set<string>;
}

function moduleNames(source: string): IModuleNames {
  const commits = new Set<string>();
  for (const match of source.matchAll(
    /@(?:Mutation|Action|MutationAction)\b(?:\([^)]*\))?\s+(?:(?:public|private|protected|static|async)\s+)*(\w+)\s*\(/g,
  )) {
    commits.add(match[1]);
  }
  const getters = new Set<string>();
  // Getters of the module class only: from its decorator on.
  const moduleStart = source.indexOf("@Module(");
  for (const match of source
    .slice(moduleStart)
    .matchAll(
      /^\s+(?:(?:public|private|protected|static)\s+)*get\s+(\w+)\s*\(/gm,
    )) {
    getters.add(match[1]);
  }
  return { commits, getters };
}

function storeModules(): Map<string, IModuleNames> {
  const modules = new Map<string, IModuleNames>();
  for (const file of readdirSync(STORE_DIR)) {
    if (!file.endsWith(".ts") || file.includes(".test.")) {
      continue;
    }
    const source = readFileSync(join(STORE_DIR, file), "utf8");
    if (source.includes("@Module(")) {
      modules.set(file, moduleNames(source));
    }
  }
  return modules;
}

describe("scalar map store names", () => {
  it("parses the store modules it guards", () => {
    const modules = storeModules();
    // Sanity: the parser sees known declarations, so an empty set below is
    // not a parsing failure.
    expect(modules.get("index.ts")?.commits.has("setMaps")).toBe(true);
    expect(modules.get("transcripts.ts")?.commits.has("refreshSchema")).toBe(
      true,
    );
    expect(modules.get(SCALAR_MAPS)?.commits.has("refreshScalarMaps")).toBe(
      true,
    );
    expect(modules.get(SCALAR_MAPS)?.getters.has("currentMaps")).toBe(true);
  });

  it("declares no mutation, action or getter another store module declares", () => {
    const modules = storeModules();
    const own = modules.get(SCALAR_MAPS)!;
    const clashes: string[] = [];
    modules.forEach((names, file) => {
      if (file === SCALAR_MAPS) {
        return;
      }
      own.commits.forEach((name) => {
        if (names.commits.has(name)) {
          clashes.push(`${name} (also in ${file})`);
        }
      });
      own.getters.forEach((name) => {
        if (names.getters.has(name)) {
          clashes.push(`getter ${name} (also in ${file})`);
        }
      });
    });
    expect(clashes).toEqual([]);
  });

  it("documents why: an un-namespaced mutation name runs in every module declaring it", () => {
    const store = createStore({});
    const first = vi.fn();
    const second = vi.fn();

    @Module({ dynamic: true, store, name: "collisionFirst" })
    class First extends VuexModule {
      @Mutation
      setThing(value: number) {
        first(value);
      }
    }

    @Module({ dynamic: true, store, name: "collisionSecond" })
    class Second extends VuexModule {
      @Mutation
      setThing(value: number) {
        second(value);
      }
    }

    getModule(First).setThing(1);
    expect(first).toHaveBeenCalledWith(1);
    expect(second).toHaveBeenCalledWith(1);
    void Second;
  });
});

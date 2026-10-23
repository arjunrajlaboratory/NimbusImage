import { describe, it, expect, vi } from "vitest";

vi.mock("@/store", () => ({ default: {} }));
vi.mock("./operations", () => ({}));

import { PARAM_ACTIONS } from "./catalog";
import { AGENT_TOOL_NAMES } from "@/agent/executors";

describe("parameterized action catalog", () => {
  it("names an agent tool that exists for every action", () => {
    for (const action of PARAM_ACTIONS) {
      expect(AGENT_TOOL_NAMES, action.id).toContain(action.agentTool);
    }
  });

  it("has unique ids", () => {
    const ids = PARAM_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

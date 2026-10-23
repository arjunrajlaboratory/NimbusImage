import { describe, it, expect } from "vitest";
import { userDisplayInfo } from "./userDisplay";

describe("userDisplayInfo", () => {
  it("uses the name and email when both are present", () => {
    expect(
      userDisplayInfo({
        firstName: "John",
        lastName: "Doe",
        login: "jdoe",
        email: "jdoe@test.com",
      }),
    ).toEqual({ full: "John Doe (jdoe@test.com)", short: "John Doe" });
  });

  it("falls back to the login when the email is hidden", () => {
    expect(
      userDisplayInfo({ firstName: "John", lastName: "Doe", login: "jdoe" }),
    ).toEqual({ full: "John Doe (jdoe)", short: "John Doe" });
  });

  it("uses the login as the name when no name is set", () => {
    expect(
      userDisplayInfo({ firstName: "", lastName: "", login: "jdoe" }),
    ).toEqual({ full: "jdoe (jdoe)", short: "jdoe" });
  });
});

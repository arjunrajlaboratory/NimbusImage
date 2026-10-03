import { describe, it, expect } from "vitest";
import { userDisplayName } from "./userDisplay";

describe("userDisplayName", () => {
  it("uses the full name and appends the email when both are visible", () => {
    expect(
      userDisplayName({
        firstName: "John",
        lastName: "Doe",
        email: "john@example.com",
      }),
    ).toEqual({ short: "John Doe", full: "John Doe (john@example.com)" });
  });

  // The User model exposes `email` only at ADMIN level — your own account or a
  // site admin. Looking up somebody else's account legitimately returns no
  // email, and the display must not read "John Doe (undefined)".
  it("omits the parenthetical when the email is not visible", () => {
    expect(userDisplayName({ firstName: "John", lastName: "Doe" })).toEqual({
      short: "John Doe",
      full: "John Doe",
    });
  });

  it("falls back to the login when no name is set", () => {
    expect(userDisplayName({ login: "jdoe" })).toEqual({
      short: "jdoe",
      full: "jdoe",
    });
  });

  it("still appends a visible email when only the login is known", () => {
    expect(
      userDisplayName({ login: "jdoe", email: "jdoe@example.com" }),
    ).toEqual({ short: "jdoe", full: "jdoe (jdoe@example.com)" });
  });

  it("uses whichever single name part is present", () => {
    expect(userDisplayName({ firstName: "John" }).short).toBe("John");
    expect(userDisplayName({ lastName: "Doe" }).short).toBe("Doe");
  });

  it("degrades to a placeholder rather than 'undefined undefined'", () => {
    expect(userDisplayName({})).toEqual({
      short: "Unknown user",
      full: "Unknown user",
    });
    expect(userDisplayName(null)).toEqual({
      short: "Unknown user",
      full: "Unknown user",
    });
  });
});

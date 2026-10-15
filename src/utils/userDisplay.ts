import type { IGirderUser } from "@/girder";

export interface IUserDisplayInfo {
  full: string; // "Name (email or login)" — used in tooltips and project list
  short: string; // "Name" only — used in dense rows
}

/** Labels for a user. Girder exposes another user's email only to site
 * admins, so the login stands in for it, and for the name when none is set. */
export function userDisplayInfo(
  user: Pick<IGirderUser, "firstName" | "lastName" | "login" | "email">,
): IUserDisplayInfo {
  const username = user.email || user.login;
  const short = `${user.firstName} ${user.lastName}`.trim() || username;
  return { full: `${short} (${username})`, short };
}

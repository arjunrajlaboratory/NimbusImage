/**
 * Build the display strings for a Girder user.
 *
 * Every field here is optional on purpose. The User model exposes `email` only
 * at ADMIN level — your own account, or a site admin — so a lookup of somebody
 * else's account comes back with `login` but no `email`, and interpolating it
 * blindly renders "John Doe (undefined)". `firstName`/`lastName` are exposed at
 * READ but are not required to be set, so they can be absent too.
 *
 * Three call sites computed this independently and two of them shipped the
 * `(undefined)`; keep them all going through here.
 */
export interface IUserDisplayNames {
  /** Name alone, for compact contexts. */
  short: string;
  /** Name plus email when the email is visible, otherwise the name alone. */
  full: string;
}

export function userDisplayName(
  user:
    | {
        firstName?: string;
        lastName?: string;
        login?: string;
        email?: string;
      }
    | null
    | undefined,
): IUserDisplayNames {
  const short =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() ||
    user?.login ||
    "Unknown user";
  return {
    short,
    full: user?.email ? `${short} (${user.email})` : short,
  };
}

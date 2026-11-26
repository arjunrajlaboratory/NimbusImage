/**
 * Logout ends with a full page reload. The stores are dynamic modules that
 * live as long as the page, and resetting them one by one at logout cannot
 * show that none was missed: caches, notifications and half-finished flows
 * of one account reached the next person at the tab. A reload discards all
 * of it at once.
 *
 * The reloaded page must know it follows a logout, so it does not greet the
 * user who just logged out with the login dialog. That one fact crosses the
 * reload in sessionStorage and is read once.
 */

const STORAGE_KEY = "nimbus.loggedOut";

/** Reload the app after a logout. The caller has already navigated to the
 * page the next session should start on. */
export function restartAfterLogout(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Storage is unavailable: the reload still happens, with the dialog.
  }
  window.location.reload();
}

/** Whether this page load follows a logout. True at most once. */
export function takeLogoutRestart(): boolean {
  try {
    const followsLogout = sessionStorage.getItem(STORAGE_KEY) !== null;
    sessionStorage.removeItem(STORAGE_KEY);
    return followsLogout;
  } catch {
    return false;
  }
}

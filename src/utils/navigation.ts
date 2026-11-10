/** Leave the app for another site (e.g. an OAuth client's callback).
 * A function of its own so tests can observe it. */
export function leaveApp(url: string): void {
  window.location.assign(url);
}

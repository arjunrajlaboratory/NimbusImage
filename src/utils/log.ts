/* eslint-disable no-console */
import { captureError } from "./sentry";

export const logWarning = console.warn;

export const logError = (...args: unknown[]) => {
  console.error(...args);
  captureError(args);
};

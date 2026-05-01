import * as Sentry from "@sentry/vue";
import type { App } from "vue";

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;

let initialized = false;

export function initSentry(app: App) {
  if (!dsn) return;

  Sentry.init({
    app,
    dsn,
    environment:
      (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ||
      import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE as string | undefined,
    // NimbusImage handles user science data; do not send IPs, cookies,
    // or request bodies by default.
    sendDefaultPii: false,
    // Errors only — no performance tracing or session replay.
    integrations: [],
    tracesSampleRate: 0,
    beforeSend(event) {
      // Strip URL query strings which may carry dataset/file identifiers
      // or filenames that we don't want to send to a third-party service.
      if (event.request?.url) {
        event.request.url = event.request.url.split("?")[0];
      }
      event.breadcrumbs?.forEach((b) => {
        if (typeof b.data?.url === "string") {
          b.data.url = b.data.url.split("?")[0];
        }
      });
      return event;
    },
  });

  initialized = true;
}

export function captureError(args: unknown[]) {
  if (!initialized) return;
  const err = args.find((a): a is Error => a instanceof Error);
  if (err) {
    const extras = args.filter((a) => a !== err);
    Sentry.captureException(err, {
      extra: extras.length ? { args: extras } : undefined,
    });
  } else {
    Sentry.captureMessage(args.map(stringifyArg).join(" "), "error");
  }
}

function stringifyArg(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack || v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

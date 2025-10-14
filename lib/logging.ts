import { redact } from "./utils";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const envLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";
const threshold = LEVELS[envLevel] ?? LEVELS.info;

export type LogContext = {
  requestId?: string;
  tenantId?: string;
  actor?: string;
  component?: string;
  tags?: string[];
};

function sanitize(payload: unknown): unknown {
  if (!payload) {
    return payload;
  }
  if (typeof payload === "string") {
    return redact(payload);
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => sanitize(item));
  }
  if (typeof payload === "object") {
    return Object.fromEntries(
      Object.entries(payload).map(([key, value]) => {
        if (typeof value === "string" && key.toLowerCase().match(/email|phone/)) {
          return [key, redact(value)];
        }
        return [key, sanitize(value as never)];
      })
    );
  }
  return payload;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function createLogger(context: LogContext = {}) {
  function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
    if (LEVELS[level] < threshold) {
      return;
    }

    const timestamp = new Date().toISOString();
    const sanitizedMeta = sanitize(meta);
    const metaRecord = toRecord(sanitizedMeta) ?? undefined;

    const record = {
      ts: timestamp,
      level,
      msg: message,
      ...context,
      ...(metaRecord ?? {})
    };

    if (!metaRecord && sanitizedMeta !== undefined) {
      (record as Record<string, unknown>).meta = sanitizedMeta;
    }

    switch (level) {
      case "debug":
        console.debug(JSON.stringify(record));
        break;
      case "info":
        console.info(JSON.stringify(record));
        break;
      case "warn":
        console.warn(JSON.stringify(record));
        break;
      case "error":
        console.error(JSON.stringify(record));
        break;
      default:
        console.log(JSON.stringify(record));
    }
  }

  return {
    child(childContext: LogContext = {}) {
      return createLogger({ ...context, ...childContext });
    },
    debug(message: string, meta?: Record<string, unknown>) {
      log("debug", message, meta);
    },
    info(message: string, meta?: Record<string, unknown>) {
      log("info", message, meta);
    },
    warn(message: string, meta?: Record<string, unknown>) {
      log("warn", message, meta);
    },
    error(message: string, meta?: Record<string, unknown>) {
      log("error", message, meta);
    }
  };
}

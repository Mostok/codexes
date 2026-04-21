export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

export interface LogSink {
  write(level: LogLevel, event: string, details?: Record<string, unknown>): void;
}

export interface Logger {
  debug(event: string, details?: Record<string, unknown>): void;
  info(event: string, details?: Record<string, unknown>): void;
  warn(event: string, details?: Record<string, unknown>): void;
  error(event: string, details?: Record<string, unknown>): void;
}

export function resolveLogLevel(value: string | undefined): LogLevel {
  switch (value?.toUpperCase()) {
    case "ERROR":
      return "ERROR";
    case "WARN":
      return "WARN";
    case "INFO":
      return "INFO";
    case "DEBUG":
      return "DEBUG";
    default:
      return "ERROR";
  }
}

export function createLogSink(
  stream: Pick<NodeJS.WriteStream, "write">,
): LogSink {
  return {
    write(level, event, details = {}) {
      stream.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level,
          event,
          details,
        })}\n`,
      );
    },
  };
}

export function createSilentLogSink(): LogSink {
  return {
    write() {},
  };
}

export function createLogger(input: {
  level: string;
  name: string;
  sink: LogSink;
}): Logger {
  const configuredLevel = resolveLogLevel(input.level);

  return {
    debug(event, details) {
      logWithLevel("DEBUG", input.name, configuredLevel, input.sink, event, details);
    },
    info(event, details) {
      logWithLevel("INFO", input.name, configuredLevel, input.sink, event, details);
    },
    warn(event, details) {
      logWithLevel("WARN", input.name, configuredLevel, input.sink, event, details);
    },
    error(event, details) {
      logWithLevel("ERROR", input.name, configuredLevel, input.sink, event, details);
    },
  };
}

function logWithLevel(
  level: LogLevel,
  name: string,
  configuredLevel: LogLevel,
  sink: LogSink,
  event: string,
  details?: Record<string, unknown>,
): void {
  if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[configuredLevel]) {
    return;
  }

  sink.write(level, `${name}.${event}`, details);
}

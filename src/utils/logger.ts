/**
 * Logger utility using Winston
 */

import winston from 'winston';

export interface LogMetadata {
  service?: string;
  action?: string;
  duration?: number;
  [key: string]: unknown;
}

const { combine, timestamp, printf, colorize, errors } = winston.format;

function serializeError(_key: string, value: unknown): unknown {
  if (!(value instanceof Error)) return value;
  return { ...value, name: value.name, message: value.message, stack: value.stack };
}

/** Custom log format */
const logFormat = printf(({ level, message, timestamp, service, action, duration, ...metadata }) => {
  let log = `${timestamp} [${level}]`;

  if (service) {
    log += ` [${service}]`;
  }
  if (action) {
    log += ` ${action}`;
  }

  log += `: ${message}`;

  if (duration !== undefined) {
    log += ` (${duration}ms)`;
  }

  // Add any additional metadata
  const extraKeys = Object.keys(metadata).filter(
    key => !['level', 'message', 'timestamp', 'service', 'action', 'duration'].includes(key)
  );

  if (extraKeys.length > 0) {
    const extra: Record<string, unknown> = {};
    for (const key of extraKeys) {
      extra[key] = metadata[key];
    }
    log += ` ${JSON.stringify(extra, serializeError)}`;
  }

  return log;
});

/** JSON format for production */
const jsonFormat = printf(({ level, message, timestamp, ...metadata }) => {
  return JSON.stringify({
    timestamp,
    level,
    message,
    ...metadata,
  }, serializeError);
});

/** Create logger instance */
function createLogger() {
  const level = process.env.LOG_LEVEL || 'info';
  const isProduction = process.env.NODE_ENV === 'production';

  return winston.createLogger({
    level,
    format: combine(
      errors({ stack: true }),
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      isProduction ? jsonFormat : combine(colorize(), logFormat)
    ),
    transports: [
      // Write ALL logs to stderr so stdout is reserved for MCP JSON-RPC
      new winston.transports.Console({
        stderrLevels: ['error', 'warn', 'info', 'debug'],
      }),
    ],
    // Don't exit on error
    exitOnError: false,
  });
}

/** Logger instance */
export const logger = createLogger();

/**
 * Create a child logger with preset metadata
 */
export function createServiceLogger(service: string) {
  return {
    debug: (message: string, meta?: LogMetadata) =>
      logger.debug(message, { service, ...meta }),
    info: (message: string, meta?: LogMetadata) =>
      logger.info(message, { service, ...meta }),
    warn: (message: string, meta?: LogMetadata) =>
      logger.warn(message, { service, ...meta }),
    error: (message: string, meta?: LogMetadata & { error?: Error }) => {
      const { error, ...rest } = meta || {};
      logger.error(message, {
        service,
        ...rest,
        ...(error && {
          errorMessage: error.message,
          errorStack: error.stack,
        }),
      });
    },
  };
}

/**
 * Log tool execution with timing
 */
export async function logToolExecution<T>(
  toolName: string,
  service: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  const log = createServiceLogger(service);

  log.debug(`Executing tool: ${toolName}`);

  try {
    const result = await fn();
    const duration = Date.now() - start;
    log.info(`Tool completed: ${toolName}`, { action: toolName, duration });
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    log.error(`Tool failed: ${toolName}`, {
      action: toolName,
      duration,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    throw error;
  }
}

export default logger;

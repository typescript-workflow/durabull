import type { DurabullLogger } from '../config/global';

const noop = () => {
  /* noop */
};

export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

export interface StructuredLogContext {
  workflowId?: string;
  workflowName?: string;
  activityId?: string;
  activityName?: string;
  phase?: string;
  attempt?: number;
  [key: string]: unknown;
}

const noopLogger: Logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
};

const normalize = (logger?: DurabullLogger): Logger => {
  if (!logger) {
    return noopLogger;
  }

  return {
    info: (...args: unknown[]) => {
      logger.info?.(...args);
    },
    warn: (...args: unknown[]) => {
      logger.warn?.(...args);
    },
    error: (...args: unknown[]) => {
      logger.error?.(...args);
    },
    debug: (...args: unknown[]) => {
      logger.debug?.(...args);
    },
  };
};

const consoleLogger: Logger = {
  info: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

export function getLogger(): Logger {
  return consoleLogger;
}

export function createLoggerFromConfig(logger?: DurabullLogger): Logger {
  return normalize(logger);
}

/**
 * Create a structured logger with context
 */
export function createStructuredLogger(context: StructuredLogContext): Logger {
  const baseLogger = getLogger();

  const formatMessage = (...args: unknown[]): unknown[] => {
    const contextStr = Object.entries(context)
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    
    const message = args.length > 0 && typeof args[0] === 'string' ? args[0] : '';
    const rest = args.length > 1 ? args.slice(1) : [];
    
    return [`[${contextStr}] ${message}`, ...rest];
  };

  return {
    info: (...args: unknown[]) => {
      baseLogger.info(...formatMessage(...args));
    },
    warn: (...args: unknown[]) => {
      baseLogger.warn(...formatMessage(...args));
    },
    error: (...args: unknown[]) => {
      baseLogger.error(...formatMessage(...args));
    },
    debug: (...args: unknown[]) => {
      baseLogger.debug(...formatMessage(...args));
    },
  };
}

import { Durabull } from '../config/global';
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

export function getLogger(): Logger {
  if (!Durabull.isConfigured()) {
    return noopLogger;
  }

  const config = Durabull.getConfig();
  return normalize(config.logger);
}

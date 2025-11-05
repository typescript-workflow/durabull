/**
 * Global configuration for Durabull
 */

export interface DurabullGlobalConfig {
  redisUrl: string;
  queues?: {
    workflow?: string;
    activity?: string;
  };
  serializer?: 'json' | 'base64';
  pruneAge?: string;
  webhooks?: {
    route?: string;
    auth?: {
      method: 'none' | 'token' | 'signature' | 'custom';
      header?: string;
      token?: string;
    };
  };
  testMode?: boolean; // Run in test mode without Redis/BullMQ
  logger?: DurabullLogger;
}

export interface DurabullLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

let globalConfig: DurabullGlobalConfig | null = null;

export class Durabull {
  static configure(config: DurabullGlobalConfig) {
    globalConfig = {
      ...config,
      queues: {
        workflow: config.queues?.workflow || 'durabull:workflow',
        activity: config.queues?.activity || 'durabull:activity',
      },
      serializer: config.serializer || 'json',
      pruneAge: config.pruneAge || '30 days',
      testMode: config.testMode || false,
      logger: config.logger,
    };
  }

  static getConfig(): DurabullGlobalConfig {
    if (!globalConfig) {
      throw new Error('Durabull not configured. Call Durabull.configure() first.');
    }
    return globalConfig;
  }

  static isConfigured(): boolean {
    return globalConfig !== null;
  }
}

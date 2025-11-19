/**
 * Pluggable serializers for data persistence
 */

/**
 * Serializer interface
 */
export interface Serializer {
  serialize<T>(data: T): string;
  deserialize<T>(str: string): T;
}

/**
 * JSON serializer (default)
 */
export class JsonSerializer implements Serializer {
  serialize<T>(data: T): string {
    if (data === undefined) {
      return JSON.stringify({ __type: 'undefined' });
    }
    return JSON.stringify(data);
  }

  deserialize<T>(str: string): T {
    const parsed = JSON.parse(str);
    if (parsed && typeof parsed === 'object' && parsed.__type === 'undefined') {
      return undefined as T;
    }
    return parsed as T;
  }
}

/**
 * Base64-encoded JSON serializer
 */
export class Base64Serializer implements Serializer {
  serialize<T>(data: T): string {
    const json = JSON.stringify(data);
    return Buffer.from(json).toString('base64');
  }

  deserialize<T>(str: string): T {
    const json = Buffer.from(str, 'base64').toString('utf-8');
    return JSON.parse(json) as T;
  }
}

/**
 * Get serializer by name
 */
export function getSerializer(name: 'json' | 'base64' = 'json'): Serializer {
  switch (name) {
    case 'json':
      return new JsonSerializer();
    case 'base64':
      return new Base64Serializer();
    default:
      return new JsonSerializer();
  }
}

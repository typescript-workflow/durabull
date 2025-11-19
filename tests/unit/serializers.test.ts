/**
 * Unit tests for serializers
 */

import { getSerializer } from '../../src/serializers';

describe('Serializers', () => {
  describe('json serializer', () => {
    const serializer = getSerializer('json');

    it('should serialize and deserialize objects', () => {
      const data = { foo: 'bar', num: 42, nested: { value: true } };
      const serialized = serializer.serialize(data);
      expect(typeof serialized).toBe('string');
      
      const deserialized = serializer.deserialize(serialized);
      expect(deserialized).toEqual(data);
    });

    it('should handle arrays', () => {
      const data = [1, 2, 3, 'four', { five: 5 }];
      const serialized = serializer.serialize(data);
      const deserialized = serializer.deserialize(serialized);
      expect(deserialized).toEqual(data);
    });

    it('should handle null and undefined', () => {
      expect(serializer.deserialize(serializer.serialize(null))).toBe(null);
      expect(serializer.deserialize(serializer.serialize(undefined))).toBe(undefined);
    });

    it('should handle primitives', () => {
      expect(serializer.deserialize(serializer.serialize(42))).toBe(42);
      expect(serializer.deserialize(serializer.serialize('string'))).toBe('string');
      expect(serializer.deserialize(serializer.serialize(true))).toBe(true);
      expect(serializer.deserialize(serializer.serialize(false))).toBe(false);
    });
  });

  describe('base64 serializer', () => {
    const serializer = getSerializer('base64');

    it('should serialize and deserialize objects', () => {
      const data = { foo: 'bar', num: 42 };
      const serialized = serializer.serialize(data);
      expect(typeof serialized).toBe('string');
      expect(serialized).not.toContain('{');
      
      const deserialized = serializer.deserialize(serialized);
      expect(deserialized).toEqual(data);
    });

    it('should handle complex nested structures', () => {
      const data = {
        users: [
          { id: 1, name: 'Alice', active: true },
          { id: 2, name: 'Bob', active: false }
        ],
        metadata: {
          timestamp: 1234567890,
          version: '1.0.0'
        }
      };
      
      const serialized = serializer.serialize(data);
      const deserialized = serializer.deserialize(serialized);
      expect(deserialized).toEqual(data);
    });
  });

  describe('serializer selection', () => {
    it('should return json serializer by default', () => {
      const serializer = getSerializer('json');
      expect(serializer).toBeDefined();
      expect(typeof serializer.serialize).toBe('function');
      expect(typeof serializer.deserialize).toBe('function');
    });

    it('should return base64 serializer when requested', () => {
      const serializer = getSerializer('base64');
      expect(serializer).toBeDefined();
      
      const data = { test: 'value' };
      const jsonSer = getSerializer('json').serialize(data);
      const base64Ser = serializer.serialize(data);
      expect(jsonSer).not.toBe(base64Ser);
    });
  });
});

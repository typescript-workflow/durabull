/**
 * Storage facade for workflow persistence
 */

import { Redis } from 'ioredis';
import { WorkflowRecord, History, HistoryEvent } from './history';
import { getSerializer } from '../serializers';
import { Durabull } from '../config/global';

/**
 * Signal envelope
 */
export interface SignalEnvelope {
  name: string;
  payload: unknown;
  ts: number;
}

/**
 * Storage interface for workflow persistence
 */
export interface Storage {
  writeRecord(rec: WorkflowRecord): Promise<void>;
  readRecord(id: string): Promise<WorkflowRecord | null>;
  writeHistory(id: string, hist: History): Promise<void>;
  readHistory(id: string): Promise<History | null>;
  appendEvent(id: string, ev: HistoryEvent): Promise<void>;
  listSignals(id: string): Promise<SignalEnvelope[]>;
  pushSignal(id: string, signal: SignalEnvelope): Promise<void>;
  popSignal(id: string): Promise<SignalEnvelope | null>;
  acquireLock(id: string, lockName: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(id: string, lockName: string): Promise<void>;
  refreshHeartbeat(workflowId: string, activityId: string, ttlSeconds: number): Promise<void>;
  checkHeartbeat(workflowId: string, activityId: string): Promise<number | null>;
  addChild(parentId: string, childId: string): Promise<void>;
  getChildren(parentId: string): Promise<string[]>;
}

/**
 * Redis-based storage implementation
 */
export class RedisStorage implements Storage {
  private redis: Redis;
  private serializer = getSerializer(Durabull.isConfigured() ? Durabull.getConfig().serializer : 'json');

  constructor(redisUrl?: string) {
    const url = redisUrl || (Durabull.isConfigured() ? Durabull.getConfig().redisUrl : 'redis://localhost:6379');
    this.redis = new Redis(url);
  }

  /**
   * Write workflow record
   */
  async writeRecord(rec: WorkflowRecord): Promise<void> {
    const key = this.getRecordKey(rec.id);
    const data = this.serializer.serialize(rec);
    await this.redis.set(key, data);
  }

  /**
   * Read workflow record
   */
  async readRecord(id: string): Promise<WorkflowRecord | null> {
    const key = this.getRecordKey(id);
    const data = await this.redis.get(key);
    if (!data) return null;
    return this.serializer.deserialize<WorkflowRecord>(data);
  }

  /**
   * Write complete history
   */
  async writeHistory(id: string, hist: History): Promise<void> {
    const key = this.getHistoryKey(id);
    const data = this.serializer.serialize(hist);
    await this.redis.set(key, data);
  }

  /**
   * Read history
   */
  async readHistory(id: string): Promise<History | null> {
    const key = this.getHistoryKey(id);
    const data = await this.redis.get(key);
    if (!data) return null;
    return this.serializer.deserialize<History>(data);
  }

  /**
   * Append event to history (optimized)
   */
  async appendEvent(id: string, ev: HistoryEvent): Promise<void> {
    // Read, append, write pattern (could use Lua script for atomicity)
    const hist = await this.readHistory(id) || { events: [], cursor: 0 };
    hist.events.push(ev);
    await this.writeHistory(id, hist);
  }

  /**
   * List all signals for a workflow
   */
  async listSignals(id: string): Promise<SignalEnvelope[]> {
    const key = this.getSignalsKey(id);
    const items = await this.redis.lrange(key, 0, -1);
    return items.map(item => this.serializer.deserialize<SignalEnvelope>(item));
  }

  /**
   * Push signal to workflow queue
   */
  async pushSignal(id: string, signal: SignalEnvelope): Promise<void> {
    const key = this.getSignalsKey(id);
    const data = this.serializer.serialize(signal);
    await this.redis.lpush(key, data);
  }

  /**
   * Pop signal from workflow queue (FIFO)
   */
  async popSignal(id: string): Promise<SignalEnvelope | null> {
    const key = this.getSignalsKey(id);
    const data = await this.redis.rpop(key);
    if (!data) return null;
    return this.serializer.deserialize<SignalEnvelope>(data);
  }

  /**
   * Acquire a lock for workflow or activity
   */
  async acquireLock(id: string, lockName: string, ttlSeconds: number): Promise<boolean> {
    const key = this.getLockKey(id, lockName);
    const result = await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  /**
   * Release a lock
   */
  async releaseLock(id: string, lockName: string): Promise<void> {
    const key = this.getLockKey(id, lockName);
    await this.redis.del(key);
  }

  /**
   * Refresh activity heartbeat
   */
  async refreshHeartbeat(workflowId: string, activityId: string, ttlSeconds: number): Promise<void> {
    const key = this.getHeartbeatKey(workflowId, activityId);
    await this.redis.set(key, Date.now().toString(), 'EX', ttlSeconds);
  }

  /**
   * Check last heartbeat timestamp
   */
  async checkHeartbeat(workflowId: string, activityId: string): Promise<number | null> {
    const key = this.getHeartbeatKey(workflowId, activityId);
    const data = await this.redis.get(key);
    return data ? parseInt(data, 10) : null;
  }

  /**
   * Add child workflow relationship
   */
  async addChild(parentId: string, childId: string): Promise<void> {
    const key = this.getChildrenKey(parentId);
    await this.redis.sadd(key, childId);
  }

  /**
   * Get all children of a workflow
   */
  async getChildren(parentId: string): Promise<string[]> {
    const key = this.getChildrenKey(parentId);
    return await this.redis.smembers(key);
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }

  // Key builders
  private getRecordKey(id: string): string {
    return `durabull:wf:${id}:record`;
  }

  private getHistoryKey(id: string): string {
    return `durabull:wf:${id}:history`;
  }

  private getSignalsKey(id: string): string {
    return `durabull:wf:${id}:signals`;
  }

  private getLockKey(id: string, lockName: string): string {
    return `durabull:wf:${id}:locks:${lockName}`;
  }

  private getHeartbeatKey(workflowId: string, activityId: string): string {
    return `durabull:wf:${workflowId}:act:${activityId}:hb`;
  }

  private getChildrenKey(parentId: string): string {
    return `durabull:wf:${parentId}:children`;
  }
}

/**
 * Global storage instance
 */
let storageInstance: Storage | null = null;

/**
 * Get or create storage instance
 */
export function getStorage(): Storage {
  if (!storageInstance) {
    storageInstance = new RedisStorage();
  }
  return storageInstance;
}

/**
 * Set custom storage implementation
 */
export function setStorage(storage: Storage): void {
  storageInstance = storage;
}

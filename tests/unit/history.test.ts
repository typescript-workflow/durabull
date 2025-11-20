import { WorkflowRecord, History, HistoryEvent } from '../../src/runtime/history';

describe('History and Records', () => {
  describe('WorkflowRecord', () => {
    it('should create valid workflow record', () => {
      const record: WorkflowRecord = {
        id: 'wf-123',
        class: 'TestWorkflow',
        status: 'pending',
        args: ['arg1', 42],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      expect(record.id).toBe('wf-123');
      expect(record.class).toBe('TestWorkflow');
      expect(record.status).toBe('pending');
      expect(record.args).toEqual(['arg1', 42]);
    });

    it('should support all workflow statuses', () => {
      const statuses: Array<WorkflowRecord['status']> = [
        'created',
        'pending',
        'running',
        'waiting',
        'completed',
        'failed',
        'continued',
      ];

      statuses.forEach((status) => {
        const record: WorkflowRecord = {
          id: 'wf-test',
          class: 'TestWorkflow',
          status,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        expect(record.status).toBe(status);
      });
    });

    it('should support waiting configuration', () => {
      const record: WorkflowRecord = {
        id: 'wf-waiting',
        class: 'TestWorkflow',
        status: 'waiting',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        waiting: {
          type: 'await',
          resumeAt: Date.now() + 5000,
        },
      };

      expect(record.waiting?.type).toBe('await');
      expect(record.waiting?.resumeAt).toBeGreaterThan(Date.now());
    });

    it('should support continuation tracking', () => {
      const record: WorkflowRecord = {
        id: 'wf-old',
        class: 'TestWorkflow',
        status: 'continued',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        continuedTo: 'wf-new',
      };

      expect(record.continuedTo).toBe('wf-new');

      const newRecord: WorkflowRecord = {
        id: 'wf-new',
        class: 'TestWorkflow',
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        continuedFrom: 'wf-old',
      };

      expect(newRecord.continuedFrom).toBe('wf-old');
    });
  });

  describe('History', () => {
    it('should create empty history', () => {
      const history: History = {
        events: [],
        cursor: 0,
      };

      expect(history.events).toHaveLength(0);
      expect(history.cursor).toBe(0);
    });

    it('should track replay cursor', () => {
      const history: History = {
        events: [
          { type: 'activity', id: 'act-1', ts: Date.now(), result: 'result1' },
          { type: 'activity', id: 'act-2', ts: Date.now(), result: 'result2' },
        ],
        cursor: 1,
      };

      expect(history.events).toHaveLength(2);
      expect(history.cursor).toBe(1);
    });
  });

  describe('HistoryEvent', () => {
    it('should create activity event with result', () => {
      const event: HistoryEvent = {
        type: 'activity',
        id: 'act-123',
        ts: Date.now(),
        result: { data: 'success' },
      };

      expect(event.type).toBe('activity');
      expect(event.id).toBe('act-123');
      expect('result' in event).toBe(true);
    });

    it('should create activity event with error', () => {
      const event: HistoryEvent = {
        type: 'activity',
        id: 'act-failed',
        ts: Date.now(),
        error: { message: 'Activity failed', stack: 'stack trace' },
      };

      expect(event.type).toBe('activity');
      expect('error' in event).toBe(true);
      expect(event.error?.message).toBe('Activity failed');
    });

    it('should create timer event', () => {
      const event: HistoryEvent = {
        type: 'timer',
        id: 'timer-1',
        ts: Date.now(),
        delay: 5,
      };

      expect(event.type).toBe('timer');
      expect(event.delay).toBe(5);
    });

    it('should create signal event', () => {
      const event: HistoryEvent = {
        type: 'signal',
        id: 'sig-1',
        ts: Date.now(),
        name: 'cancel',
        payload: { reason: 'user requested' },
      };

      expect(event.type).toBe('signal');
      expect(event.name).toBe('cancel');
      expect(event.payload).toEqual({ reason: 'user requested' });
    });

    it('should create child workflow event', () => {
      const event: HistoryEvent = {
        type: 'child',
        id: 'child-1',
        ts: Date.now(),
        childId: 'wf-child-123',
        result: 'child result',
      };

      expect(event.type).toBe('child');
      expect(event.childId).toBe('wf-child-123');
      expect(event.result).toBe('child result');
    });

    it('should create side effect event', () => {
      const event: HistoryEvent = {
        type: 'sideEffect',
        id: 'se-1',
        ts: Date.now(),
        value: { random: Math.random() },
      };

      expect(event.type).toBe('sideEffect');
      expect('value' in event).toBe(true);
    });

    it('should create exception event', () => {
      const event: HistoryEvent = {
        type: 'exception',
        id: 'ex-1',
        ts: Date.now(),
        error: {
          message: 'Unexpected error',
          stack: 'Error: ...',
        },
      };

      expect(event.type).toBe('exception');
      expect(event.error.message).toBe('Unexpected error');
    });
  });
});

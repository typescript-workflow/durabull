import { generateWorkflowId, generateActivityId, generateTimerId, generateSideEffectId } from '../../src/runtime/ids';

describe('ID Generators', () => {
  describe('generateWorkflowId', () => {
    it('should generate unique workflow IDs', () => {
      const id1 = generateWorkflowId();
      const id2 = generateWorkflowId();
      
      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
      expect(typeof id1).toBe('string');
      expect(id1.length).toBeGreaterThan(0);
    });

    it('should generate IDs with wf prefix', () => {
      const id = generateWorkflowId();
      expect(id).toMatch(/^wf-/);
    });

    it('should generate multiple unique IDs', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(generateWorkflowId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe('generateActivityId', () => {
    it('should generate unique activity IDs', () => {
      const id1 = generateActivityId();
      const id2 = generateActivityId();
      
      expect(id1).not.toBe(id2);
      expect(typeof id1).toBe('string');
    });

    it('should generate IDs with act prefix', () => {
      const id = generateActivityId();
      expect(id).toMatch(/^act-/);
    });
  });

  describe('generateTimerId', () => {
    it('should generate unique timer IDs', () => {
      const id1 = generateTimerId();
      const id2 = generateTimerId();
      
      expect(id1).not.toBe(id2);
      expect(typeof id1).toBe('string');
    });

    it('should generate IDs with timer prefix', () => {
      const id = generateTimerId();
      expect(id).toMatch(/^timer-/);
    });
  });

  describe('generateSideEffectId', () => {
    it('should generate unique side effect IDs', () => {
      const id1 = generateSideEffectId();
      const id2 = generateSideEffectId();
      
      expect(id1).not.toBe(id2);
      expect(typeof id1).toBe('string');
    });

    it('should generate IDs with se prefix', () => {
      const id = generateSideEffectId();
      expect(id).toMatch(/^se-/);
    });
  });

  describe('ID uniqueness across types', () => {
    it('should generate different IDs for different types', () => {
      const workflowId = generateWorkflowId();
      const activityId = generateActivityId();
      const timerId = generateTimerId();
      const sideEffectId = generateSideEffectId();

      const ids = [workflowId, activityId, timerId, sideEffectId];
      const uniqueIds = new Set(ids);
      
      expect(uniqueIds.size).toBe(4);
    });
  });
});

import { describe, it, expect } from 'vitest';

describe('smoke', () => {
  // Verifies the test runner executes — expected: arithmetic holds.
  it('vitest runs — 1 + 1 equals 2', () => {
    expect(1 + 1).toBe(2);
  });
});

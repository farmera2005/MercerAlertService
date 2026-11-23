import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './helpers';

describe('isUniqueViolation', () => {
  it('finds the constraint on a wrapped driver error', () => {
    const pgErr = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint: 'noc_boards_name_unique',
    });
    const wrapped = Object.assign(new Error('Failed query: insert into "noc_boards" …'), {
      cause: pgErr,
    });
    expect(isUniqueViolation(wrapped, 'noc_boards_name_unique')).toBe(true);
    expect(isUniqueViolation(wrapped, 'sites_code_unique')).toBe(false);
    expect(isUniqueViolation(new Error('timeout'), 'noc_boards_name_unique')).toBe(false);
  });
});

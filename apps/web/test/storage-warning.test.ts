import { describe, expect, it } from 'vitest';
import { storageWarningText } from '../src/storage-warning.js';

describe('storage response warnings', () => {
  it('keeps warnings as plain text without changing known save outcomes', () => {
    expect(storageWarningText({ warnings: ['Saved.', 'Do not retry.'] })).toBe('Saved. Do not retry.');
    expect(storageWarningText({ warnings: ['<script>text only</script>', null, 42] })).toBe('<script>text only</script>');
  });
  it.each([null, undefined, {}, { warnings: 12 }, { warnings: 'not an array' }])('ignores malformed metadata: %j', input => {
    expect(storageWarningText(input)).toBe('');
  });
});

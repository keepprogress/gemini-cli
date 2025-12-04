/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateEditPossibility,
  EditValidationErrorCode,
  EditRetryTracker,
  getGlobalRetryTracker,
  resetGlobalRetryTracker,
} from './editValidator.js';

describe('validateEditPossibility', () => {
  describe('Empty file detection', () => {
    it('should reject non-empty old_string when file is empty', () => {
      const result = validateEditPossibility(
        '',
        'function foo() {}',
        'function bar() {}',
      );
      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(
        EditValidationErrorCode.EMPTY_FILE_NON_EMPTY_OLD_STRING,
      );
    });

    it('should reject non-empty old_string when file contains only whitespace', () => {
      const result = validateEditPossibility(
        '   \n\t\n   ',
        'function foo() {}',
        'function bar() {}',
      );
      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(
        EditValidationErrorCode.EMPTY_FILE_NON_EMPTY_OLD_STRING,
      );
    });

    it('should accept empty old_string for creating content in empty file', () => {
      const result = validateEditPossibility('', '', 'new content');
      expect(result.isValid).toBe(true);
    });
  });

  describe('old_string length validation', () => {
    it('should reject old_string much longer than file content', () => {
      const shortFile = 'hello world';
      const longOldString = 'a'.repeat(100); // 100 chars vs 11 chars file

      const result = validateEditPossibility(shortFile, longOldString, 'new');
      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(
        EditValidationErrorCode.OLD_STRING_TOO_LONG,
      );
    });

    it('should accept old_string similar length to file', () => {
      const file = 'hello world this is a test';
      const oldString = 'hello world';

      const result = validateEditPossibility(file, oldString, 'goodbye world');
      expect(result.isValid).toBe(true);
    });
  });

  describe('Common substring detection', () => {
    it('should reject when no common substring exists', () => {
      const fileContent = 'function calculateSum(a, b) { return a + b; }';
      const oldString = 'class Person { constructor() {} }';

      const result = validateEditPossibility(fileContent, oldString, 'new');
      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(
        EditValidationErrorCode.NO_COMMON_SUBSTRING,
      );
    });

    it('should accept when partial common substring exists', () => {
      const fileContent = 'function calculateSum(a, b) { return a + b; }';
      const oldString = 'function calculate'; // "function" is common

      const result = validateEditPossibility(fileContent, oldString, 'new');
      expect(result.isValid).toBe(true);
    });

    it('should handle multiline content with partial match', () => {
      const fileContent = `class Foo {
  constructor() {
    this.value = 1;
  }
}`;
      const oldString = `class Foo {
  constructor() {
    this.value = 999;
  }
}`; // "class Foo" and "constructor" are common

      const result = validateEditPossibility(fileContent, oldString, 'new');
      expect(result.isValid).toBe(true);
    });

    it('should be case-insensitive for common substring detection', () => {
      const fileContent = 'FUNCTION CALCULATESUM() {}';
      const oldString = 'function calculateSum() {}';

      const result = validateEditPossibility(fileContent, oldString, 'new');
      expect(result.isValid).toBe(true);
    });
  });

  describe('Binary content detection', () => {
    it('should reject content with null bytes', () => {
      const binaryContent = 'hello\0world\0test';
      const result = validateEditPossibility(binaryContent, 'hello', 'hi');
      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(
        EditValidationErrorCode.BINARY_CONTENT_DETECTED,
      );
    });

    it('should reject content with high non-printable ratio', () => {
      // Create content with many control characters
      const controlChars = String.fromCharCode(1, 2, 3, 4, 5, 6, 7);
      const binaryContent = controlChars.repeat(20) + 'hello';

      const result = validateEditPossibility(binaryContent, 'hello', 'hi');
      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(
        EditValidationErrorCode.BINARY_CONTENT_DETECTED,
      );
    });

    it('should accept normal text content', () => {
      const textContent =
        'Hello World!\nThis is a test.\n\tWith tabs and unicode: 你好';
      const result = validateEditPossibility(textContent, 'Hello', 'Hi');
      expect(result.isValid).toBe(true);
    });
  });

  describe('Whitespace-only old_string', () => {
    it('should reject old_string that is only spaces', () => {
      const result = validateEditPossibility('hello world', '    ', 'new');
      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(
        EditValidationErrorCode.OLD_STRING_IS_WHITESPACE_ONLY,
      );
    });

    it('should reject old_string that is only tabs and newlines', () => {
      const result = validateEditPossibility('hello world', '\t\n\t\n', 'new');
      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(
        EditValidationErrorCode.OLD_STRING_IS_WHITESPACE_ONLY,
      );
    });

    it('should accept empty old_string (file creation case)', () => {
      const result = validateEditPossibility('', '', 'new content');
      expect(result.isValid).toBe(true);
    });
  });

  describe('Complex edge cases', () => {
    it('should handle extremely long file with short old_string', () => {
      const longFile = 'x'.repeat(100000) + 'findme' + 'y'.repeat(100000);
      const result = validateEditPossibility(longFile, 'findme', 'replaced');
      expect(result.isValid).toBe(true);
    });

    it('should handle old_string with special regex characters', () => {
      const fileContent = 'const regex = /^[a-z]+$/g;';
      const oldString = '/^[a-z]+$/g';

      const result = validateEditPossibility(
        fileContent,
        oldString,
        '/^[A-Z]+$/g',
      );
      expect(result.isValid).toBe(true);
    });

    it('should handle Unicode content', () => {
      const fileContent = '你好世界！这是一个测试。';
      const oldString = '你好世界';

      const result = validateEditPossibility(
        fileContent,
        oldString,
        '再见世界',
      );
      expect(result.isValid).toBe(true);
    });

    it('should handle mixed line endings', () => {
      const fileContent = 'line1\r\nline2\nline3\rline4';
      const oldString = 'line2\nline3';

      const result = validateEditPossibility(
        fileContent,
        oldString,
        'replaced',
      );
      expect(result.isValid).toBe(true);
    });

    it('should handle file with only comments matching partial old_string', () => {
      const fileContent = `
// This is a comment
// Another comment
/* Block comment */
`;
      const oldString = `function doSomething() {
  // This is a comment
  return true;
}`;

      const result = validateEditPossibility(fileContent, oldString, 'new');
      // Should find "// This is a comment" as common
      expect(result.isValid).toBe(true);
    });

    it('should handle completely different code languages', () => {
      const pythonFile = `
def calculate_sum(a, b):
    return a + b

if __name__ == "__main__":
    print(calculate_sum(1, 2))
`;
      const javaScriptOldString = `
function calculateSum(a, b) {
    return a + b;
}
module.exports = { calculateSum };
`;

      const result = validateEditPossibility(
        pythonFile,
        javaScriptOldString,
        'new',
      );
      // Should find "return a + b" as common
      expect(result.isValid).toBe(true);
    });
  });
});

describe('EditRetryTracker', () => {
  let tracker: EditRetryTracker;

  beforeEach(() => {
    tracker = new EditRetryTracker(5, 2, 300000);
  });

  describe('Basic functionality', () => {
    it('should allow first edit attempt', () => {
      const result = tracker.checkRetryPattern(
        '/path/to/file.ts',
        'old',
        'new',
      );
      expect(result.shouldBlock).toBe(false);
      expect(result.consecutiveFailures).toBe(0);
    });

    it('should track failed attempts', () => {
      tracker.recordAttempt('/path/to/file.ts', 'old', 'new', false, 'ERROR');

      const stats = tracker.getStats('/path/to/file.ts');
      expect(stats.failedAttempts).toBe(1);
      expect(stats.successfulAttempts).toBe(0);
    });

    it('should track successful attempts', () => {
      tracker.recordAttempt('/path/to/file.ts', 'old', 'new', true);

      const stats = tracker.getStats('/path/to/file.ts');
      expect(stats.successfulAttempts).toBe(1);
      expect(stats.failedAttempts).toBe(0);
    });
  });

  describe('Consecutive identical failure detection', () => {
    it('should block after consecutive identical failures', () => {
      tracker.recordAttempt('/path/to/file.ts', 'old', 'new', false);
      tracker.recordAttempt('/path/to/file.ts', 'old', 'new', false);

      const result = tracker.checkRetryPattern(
        '/path/to/file.ts',
        'old',
        'new',
      );
      expect(result.shouldBlock).toBe(true);
      expect(result.consecutiveFailures).toBe(2);
    });

    it('should not block if different old_string', () => {
      tracker.recordAttempt('/path/to/file.ts', 'old1', 'new', false);
      tracker.recordAttempt('/path/to/file.ts', 'old1', 'new', false);

      const result = tracker.checkRetryPattern(
        '/path/to/file.ts',
        'old2', // Different old_string
        'new',
      );
      expect(result.shouldBlock).toBe(false);
    });

    it('should reset consecutive count after success', () => {
      tracker.recordAttempt('/path/to/file.ts', 'old', 'new', false);
      tracker.recordAttempt('/path/to/file.ts', 'old', 'new', true); // Success resets
      tracker.recordAttempt('/path/to/file.ts', 'old', 'new', false);

      const result = tracker.checkRetryPattern(
        '/path/to/file.ts',
        'old',
        'new',
      );
      expect(result.shouldBlock).toBe(false);
      expect(result.consecutiveFailures).toBe(1);
    });
  });

  describe('Total failure limit', () => {
    it('should block after too many total failures', () => {
      // Record 5 different failed attempts
      for (let i = 0; i < 5; i++) {
        tracker.recordAttempt('/path/to/file.ts', `old${i}`, `new${i}`, false);
      }

      const result = tracker.checkRetryPattern(
        '/path/to/file.ts',
        'oldNew',
        'newNew',
      );
      expect(result.shouldBlock).toBe(true);
      expect(result.totalFailures).toBe(5);
    });
  });

  describe('File-specific tracking', () => {
    it('should track files independently', () => {
      tracker.recordAttempt('/path/to/file1.ts', 'old', 'new', false);
      tracker.recordAttempt('/path/to/file1.ts', 'old', 'new', false);

      const result1 = tracker.checkRetryPattern(
        '/path/to/file1.ts',
        'old',
        'new',
      );
      const result2 = tracker.checkRetryPattern(
        '/path/to/file2.ts',
        'old',
        'new',
      );

      expect(result1.shouldBlock).toBe(true);
      expect(result2.shouldBlock).toBe(false);
    });

    it('should clear specific file data', () => {
      tracker.recordAttempt('/path/to/file.ts', 'old', 'new', false);
      tracker.recordAttempt('/path/to/file.ts', 'old', 'new', false);

      tracker.clearFile('/path/to/file.ts');

      const result = tracker.checkRetryPattern(
        '/path/to/file.ts',
        'old',
        'new',
      );
      expect(result.shouldBlock).toBe(false);
    });
  });

  describe('Time window', () => {
    it('should ignore attempts outside the time window', async () => {
      // Create tracker with very short window
      const shortWindowTracker = new EditRetryTracker(5, 2, 100); // 100ms window

      shortWindowTracker.recordAttempt('/path/to/file.ts', 'old', 'new', false);
      shortWindowTracker.recordAttempt('/path/to/file.ts', 'old', 'new', false);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Record a new attempt to trigger cleanup
      shortWindowTracker.recordAttempt('/path/to/file.ts', 'old', 'new', false);

      const result = shortWindowTracker.checkRetryPattern(
        '/path/to/file.ts',
        'old',
        'new',
      );
      // Only 1 recent failure, not 3
      expect(result.consecutiveFailures).toBe(1);
    });
  });
});

describe('Global retry tracker', () => {
  beforeEach(() => {
    resetGlobalRetryTracker();
  });

  afterEach(() => {
    resetGlobalRetryTracker();
  });

  it('should return singleton instance', () => {
    const tracker1 = getGlobalRetryTracker();
    const tracker2 = getGlobalRetryTracker();
    expect(tracker1).toBe(tracker2);
  });

  it('should persist data across calls', () => {
    const tracker = getGlobalRetryTracker();
    tracker.recordAttempt('/path/to/file.ts', 'old', 'new', false);

    const stats = getGlobalRetryTracker().getStats('/path/to/file.ts');
    expect(stats.failedAttempts).toBe(1);
  });

  it('should reset when resetGlobalRetryTracker is called', () => {
    const tracker = getGlobalRetryTracker();
    tracker.recordAttempt('/path/to/file.ts', 'old', 'new', false);

    resetGlobalRetryTracker();

    const stats = getGlobalRetryTracker().getStats('/path/to/file.ts');
    expect(stats.failedAttempts).toBe(0);
  });
});

describe('Complex and unexpected test cases', () => {
  describe('Pathological inputs', () => {
    it('should handle old_string that is the entire file content', () => {
      const fileContent = 'const x = 1;\nconst y = 2;\nconst z = 3;';
      const result = validateEditPossibility(
        fileContent,
        fileContent,
        'completely new content',
      );
      expect(result.isValid).toBe(true);
    });

    it('should handle extremely long single line', () => {
      const longLine = 'x'.repeat(1000000);
      const result = validateEditPossibility(
        longLine,
        'x'.repeat(100),
        'y'.repeat(100),
      );
      expect(result.isValid).toBe(true);
    });

    it('should handle file with thousands of identical lines', () => {
      const repeatedLines = 'const x = 1;\n'.repeat(10000);
      const result = validateEditPossibility(
        repeatedLines,
        'const x = 1;',
        'const x = 2;',
      );
      expect(result.isValid).toBe(true);
    });

    it('should handle old_string with only newlines', () => {
      const result = validateEditPossibility(
        'hello\n\n\nworld',
        '\n\n\n',
        '\n',
      );
      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(
        EditValidationErrorCode.OLD_STRING_IS_WHITESPACE_ONLY,
      );
    });

    it('should handle file that looks like JSON but is malformed', () => {
      const malformedJson = '{"key": "value", "broken: true}';
      const result = validateEditPossibility(
        malformedJson,
        '"value"',
        '"newValue"',
      );
      expect(result.isValid).toBe(true);
    });

    it('should handle old_string with escape sequences', () => {
      const fileContent = 'const str = "hello\\nworld";';
      const oldString = '"hello\\nworld"';
      const result = validateEditPossibility(
        fileContent,
        oldString,
        '"hello\\tworld"',
      );
      expect(result.isValid).toBe(true);
    });

    it('should handle minified JavaScript', () => {
      const minified =
        'function a(b){return b*2}function c(d){return d+1}var e=a(c(5));console.log(e);';
      const oldString = 'function a(b){return b*2}';
      const result = validateEditPossibility(
        minified,
        oldString,
        'function a(b){return b*3}',
      );
      expect(result.isValid).toBe(true);
    });

    it('should handle base64 encoded content (not binary)', () => {
      const base64Content =
        'SGVsbG8gV29ybGQhIFRoaXMgaXMgYSB0ZXN0Lg==\nQW5vdGhlciBsaW5lIG9mIGJhc2U2NA==';
      const result = validateEditPossibility(
        base64Content,
        'SGVsbG8',
        'R29vZGJ5ZQ',
      );
      expect(result.isValid).toBe(true);
    });

    it('should handle ANSI escape codes', () => {
      const ansiContent = '\x1b[31mRed Text\x1b[0m Normal Text';
      const result = validateEditPossibility(
        ansiContent,
        'Red Text',
        'Blue Text',
      );
      expect(result.isValid).toBe(true);
    });
  });

  describe('Race condition scenarios for retry tracker', () => {
    it('should handle rapid consecutive calls', () => {
      const tracker = new EditRetryTracker();

      // Simulate rapid fire attempts
      for (let i = 0; i < 100; i++) {
        tracker.recordAttempt('/file.ts', 'old', 'new', false);
        const result = tracker.checkRetryPattern('/file.ts', 'old', 'new');
        // Should eventually block
        if (i >= 2) {
          expect(result.shouldBlock).toBe(true);
        }
      }
    });

    it('should handle interleaved file operations', () => {
      const tracker = new EditRetryTracker();

      // Interleave operations on multiple files
      tracker.recordAttempt('/file1.ts', 'old', 'new', false);
      tracker.recordAttempt('/file2.ts', 'old', 'new', false);
      tracker.recordAttempt('/file1.ts', 'old', 'new', false);
      tracker.recordAttempt('/file2.ts', 'old', 'new', true); // Success on file2
      tracker.recordAttempt('/file1.ts', 'old', 'new', false);

      const result1 = tracker.checkRetryPattern('/file1.ts', 'old', 'new');
      const result2 = tracker.checkRetryPattern('/file2.ts', 'old', 'new');

      expect(result1.shouldBlock).toBe(true); // 3 consecutive failures
      expect(result2.shouldBlock).toBe(false); // Last was success
    });
  });

  describe('Memory and performance edge cases', () => {
    it('should not grow unbounded with many files', () => {
      const tracker = new EditRetryTracker(5, 2, 1000);

      // Record attempts for many different files
      for (let i = 0; i < 1000; i++) {
        tracker.recordAttempt(`/file${i}.ts`, 'old', 'new', false);
      }

      // Should still work correctly
      const result = tracker.checkRetryPattern('/file999.ts', 'old', 'new');
      expect(result.totalFailures).toBe(1);
    });

    it('should handle very long file paths', () => {
      const longPath = '/'.repeat(100) + 'file'.repeat(100) + '.ts';
      const tracker = new EditRetryTracker();

      tracker.recordAttempt(longPath, 'old', 'new', false);
      const stats = tracker.getStats(longPath);
      expect(stats.failedAttempts).toBe(1);
    });

    it('should handle very long old_string and new_string', () => {
      const tracker = new EditRetryTracker();
      const longString = 'x'.repeat(100000);

      tracker.recordAttempt(
        '/file.ts',
        longString,
        longString + 'modified',
        false,
      );
      tracker.recordAttempt(
        '/file.ts',
        longString,
        longString + 'modified',
        false,
      );

      const result = tracker.checkRetryPattern(
        '/file.ts',
        longString,
        longString + 'modified',
      );
      expect(result.shouldBlock).toBe(true);
    });
  });
});

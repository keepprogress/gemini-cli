/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  EditRetryTracker,
  getEditRetryTracker,
  resetEditRetryTracker_TEST_ONLY,
} from './editRetryTracker.js';
import { ToolErrorType } from '../tools/tool-error.js';

describe('EditRetryTracker', () => {
  let tracker: EditRetryTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new EditRetryTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('recordAttempt', () => {
    it('should record a successful edit attempt', () => {
      tracker.recordAttempt('/test/file.ts', 'old', 'new', null, true);

      const stats = tracker.getFileStats('/test/file.ts');
      expect(stats.totalAttempts).toBe(1);
      expect(stats.recentSuccesses).toBe(1);
      expect(stats.recentFailures).toBe(0);
    });

    it('should record a failed edit attempt', () => {
      tracker.recordAttempt(
        '/test/file.ts',
        'old',
        'new',
        ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
        false,
      );

      const stats = tracker.getFileStats('/test/file.ts');
      expect(stats.totalAttempts).toBe(1);
      expect(stats.recentSuccesses).toBe(0);
      expect(stats.recentFailures).toBe(1);
    });

    it('should filter out attempts outside the time window', () => {
      tracker.recordAttempt('/test/file.ts', 'old1', 'new1', null, true);

      // Advance time past the 60-second window
      vi.advanceTimersByTime(61000);

      tracker.recordAttempt('/test/file.ts', 'old2', 'new2', null, true);

      const stats = tracker.getFileStats('/test/file.ts');
      expect(stats.totalAttempts).toBe(1); // Only the recent one
    });
  });

  describe('checkBeforeEdit', () => {
    describe('identical failed attempts detection', () => {
      it('should block after 2 identical failed attempts', () => {
        // First failed attempt
        tracker.recordAttempt(
          '/test/file.ts',
          'old_string',
          'new_string',
          ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
          false,
        );

        // Second identical failed attempt
        tracker.recordAttempt(
          '/test/file.ts',
          'old_string',
          'new_string',
          ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
          false,
        );

        const result = tracker.checkBeforeEdit(
          '/test/file.ts',
          'old_string',
          'new_string',
          'some content',
        );

        expect(result.shouldProceed).toBe(false);
        expect(result.reason).toBe('identical_failed_attempts');
        expect(result.suggestion).toContain('read_file');
      });

      it('should allow after identical successful attempts', () => {
        tracker.recordAttempt('/test/file.ts', 'old', 'new', null, true);
        tracker.recordAttempt('/test/file.ts', 'old', 'new', null, true);

        const result = tracker.checkBeforeEdit(
          '/test/file.ts',
          'old',
          'new',
          'some old content',
        );

        expect(result.shouldProceed).toBe(true);
      });

      it('should allow different edit attempts', () => {
        tracker.recordAttempt(
          '/test/file.ts',
          'old1',
          'new1',
          ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
          false,
        );
        tracker.recordAttempt(
          '/test/file.ts',
          'old1',
          'new1',
          ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
          false,
        );

        // Different old_string, should be allowed
        const result = tracker.checkBeforeEdit(
          '/test/file.ts',
          'old2',
          'new2',
          'some content',
        );

        expect(result.shouldProceed).toBe(true);
      });
    });

    describe('too many failures detection', () => {
      it('should block after 3 failures on the same file', () => {
        tracker.recordAttempt(
          '/test/file.ts',
          'a',
          'b',
          ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
          false,
        );
        tracker.recordAttempt(
          '/test/file.ts',
          'c',
          'd',
          ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH,
          false,
        );
        tracker.recordAttempt(
          '/test/file.ts',
          'e',
          'f',
          ToolErrorType.EDIT_NO_CHANGE,
          false,
        );

        const result = tracker.checkBeforeEdit(
          '/test/file.ts',
          'new_old',
          'new_new',
          'content',
        );

        expect(result.shouldProceed).toBe(false);
        expect(result.reason).toBe('too_many_failures');
        expect(result.suggestion).toContain('write_file');
      });

      it('should allow if failures are on different files', () => {
        tracker.recordAttempt(
          '/test/file1.ts',
          'a',
          'b',
          ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
          false,
        );
        tracker.recordAttempt(
          '/test/file2.ts',
          'c',
          'd',
          ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
          false,
        );
        tracker.recordAttempt(
          '/test/file3.ts',
          'e',
          'f',
          ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
          false,
        );

        const result = tracker.checkBeforeEdit(
          '/test/file1.ts',
          'g',
          'h',
          'content',
        );

        expect(result.shouldProceed).toBe(true);
      });
    });

    describe('empty file with old_string detection', () => {
      it('should block when old_string is non-empty but file is empty', () => {
        const result = tracker.checkBeforeEdit(
          '/test/file.ts',
          'function foo() {}',
          'function bar() {}',
          '', // Empty file content
        );

        expect(result.shouldProceed).toBe(false);
        expect(result.reason).toBe('empty_file_with_old_string');
        expect(result.suggestion).toContain('old_string=""');
      });

      it('should allow when old_string is empty for new file creation', () => {
        const result = tracker.checkBeforeEdit(
          '/test/file.ts',
          '', // Empty old_string (create new file)
          'new content',
          '', // Empty file
        );

        expect(result.shouldProceed).toBe(true);
      });

      it('should allow when file has content matching old_string', () => {
        const result = tracker.checkBeforeEdit(
          '/test/file.ts',
          'old content',
          'new content',
          'this is old content here',
        );

        expect(result.shouldProceed).toBe(true);
      });
    });

    describe('stale content detection', () => {
      it('should warn when file content has changed', () => {
        // Record original content
        tracker.recordFileContent('/test/file.ts', 'original content');

        // Check with different content
        const result = tracker.checkBeforeEdit(
          '/test/file.ts',
          'old',
          'new',
          'modified content', // Different from recorded
        );

        expect(result.shouldProceed).toBe(true); // Allow but warn
        expect(result.reason).toBe('stale_content');
        expect(result.suggestion).toContain('read_file');
      });

      it('should not warn when content is the same', () => {
        tracker.recordFileContent('/test/file.ts', 'same content');

        const result = tracker.checkBeforeEdit(
          '/test/file.ts',
          'old',
          'new',
          'same content',
        );

        expect(result.reason).toBeUndefined();
      });
    });
  });

  describe('error-specific suggestions', () => {
    it('should provide specific suggestion for EDIT_NO_OCCURRENCE_FOUND', () => {
      tracker.recordAttempt(
        '/test/file.ts',
        'not found',
        'replacement',
        ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
        false,
      );
      tracker.recordAttempt(
        '/test/file.ts',
        'not found',
        'replacement',
        ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
        false,
      );

      const result = tracker.checkBeforeEdit(
        '/test/file.ts',
        'not found',
        'replacement',
        'content',
      );

      expect(result.suggestion).toContain('3+ lines before and after');
      expect(result.suggestion).toContain('whitespace/indentation');
    });

    it('should provide specific suggestion for EDIT_EXPECTED_OCCURRENCE_MISMATCH', () => {
      tracker.recordAttempt(
        '/test/file.ts',
        'duplicate',
        'replacement',
        ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH,
        false,
      );
      tracker.recordAttempt(
        '/test/file.ts',
        'duplicate',
        'replacement',
        ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH,
        false,
      );

      const result = tracker.checkBeforeEdit(
        '/test/file.ts',
        'duplicate',
        'replacement',
        'content',
      );

      expect(result.suggestion).toContain('expected_replacements');
      expect(result.suggestion).toContain('unique context');
    });
  });

  describe('clearFile and reset', () => {
    it('should clear data for a specific file', () => {
      tracker.recordAttempt('/test/file1.ts', 'a', 'b', null, true);
      tracker.recordAttempt('/test/file2.ts', 'c', 'd', null, true);

      tracker.clearFile('/test/file1.ts');

      expect(tracker.getFileStats('/test/file1.ts').totalAttempts).toBe(0);
      expect(tracker.getFileStats('/test/file2.ts').totalAttempts).toBe(1);
    });

    it('should reset all tracking data', () => {
      tracker.recordAttempt('/test/file1.ts', 'a', 'b', null, true);
      tracker.recordAttempt('/test/file2.ts', 'c', 'd', null, true);

      tracker.reset();

      expect(tracker.getFileStats('/test/file1.ts').totalAttempts).toBe(0);
      expect(tracker.getFileStats('/test/file2.ts').totalAttempts).toBe(0);
    });
  });

  describe('singleton instance', () => {
    beforeEach(() => {
      resetEditRetryTracker_TEST_ONLY();
    });

    it('should return the same instance', () => {
      const instance1 = getEditRetryTracker();
      const instance2 = getEditRetryTracker();

      expect(instance1).toBe(instance2);
    });

    it('should create new instance after reset', () => {
      const instance1 = getEditRetryTracker();
      resetEditRetryTracker_TEST_ONLY();
      const instance2 = getEditRetryTracker();

      expect(instance1).not.toBe(instance2);
    });
  });
});

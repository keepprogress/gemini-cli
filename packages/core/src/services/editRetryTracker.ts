/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolErrorType } from '../tools/tool-error.js';

/**
 * Maximum number of failed edit attempts before suggesting alternatives.
 */
const MAX_FAILED_ATTEMPTS_PER_FILE = 3;

/**
 * Time window in milliseconds for tracking recent failures (1 minute).
 */
const FAILURE_WINDOW_MS = 60000;

/**
 * Maximum number of consecutive identical edit attempts before blocking.
 */
const MAX_IDENTICAL_ATTEMPTS = 2;

/**
 * Represents a single edit attempt with its metadata.
 */
export interface EditAttempt {
  filePath: string;
  oldStringHash: string;
  newStringHash: string;
  timestamp: number;
  errorType: ToolErrorType | null;
  success: boolean;
}

/**
 * Result of checking if an edit should proceed.
 */
export interface EditCheckResult {
  shouldProceed: boolean;
  suggestion?: string;
  reason?: string;
}

/**
 * Service for tracking edit tool retry patterns and preventing infinite loops.
 *
 * This service monitors:
 * 1. Consecutive identical edit attempts (same old_string/new_string)
 * 2. Per-file failure counts within a time window
 * 3. Content staleness (when cached content doesn't match file)
 */
export class EditRetryTracker {
  private attempts: Map<string, EditAttempt[]> = new Map();
  private lastKnownContent: Map<
    string,
    { content: string; timestamp: number }
  > = new Map();

  /**
   * Simple hash function for comparing strings.
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
  }

  /**
   * Records an edit attempt.
   */
  recordAttempt(
    filePath: string,
    oldString: string,
    newString: string,
    errorType: ToolErrorType | null,
    success: boolean,
  ): void {
    const attempt: EditAttempt = {
      filePath,
      oldStringHash: this.hashString(oldString),
      newStringHash: this.hashString(newString),
      timestamp: Date.now(),
      errorType,
      success,
    };

    const fileAttempts = this.attempts.get(filePath) || [];
    fileAttempts.push(attempt);

    // Keep only recent attempts within the time window
    const cutoff = Date.now() - FAILURE_WINDOW_MS;
    const recentAttempts = fileAttempts.filter((a) => a.timestamp > cutoff);
    this.attempts.set(filePath, recentAttempts);
  }

  /**
   * Records the last known content of a file.
   */
  recordFileContent(filePath: string, content: string): void {
    this.lastKnownContent.set(filePath, {
      content,
      timestamp: Date.now(),
    });
  }

  /**
   * Checks if the file content appears stale (file was likely modified externally).
   */
  isContentStale(filePath: string, currentContent: string): boolean {
    const lastKnown = this.lastKnownContent.get(filePath);
    if (!lastKnown) {
      return false;
    }

    // If content doesn't match what we last saw, it's stale
    return lastKnown.content !== currentContent;
  }

  /**
   * Checks if an edit should proceed based on retry patterns.
   */
  checkBeforeEdit(
    filePath: string,
    oldString: string,
    newString: string,
    currentContent: string | null,
  ): EditCheckResult {
    const oldHash = this.hashString(oldString);
    const newHash = this.hashString(newString);
    const fileAttempts = this.attempts.get(filePath) || [];
    const now = Date.now();

    // Filter to recent attempts within the time window
    const recentAttempts = fileAttempts.filter(
      (a) => now - a.timestamp < FAILURE_WINDOW_MS,
    );

    // Check 1: Identical consecutive attempts
    const identicalAttempts = recentAttempts.filter(
      (a) => a.oldStringHash === oldHash && a.newStringHash === newHash,
    );

    if (identicalAttempts.length >= MAX_IDENTICAL_ATTEMPTS) {
      const lastAttempt = identicalAttempts[identicalAttempts.length - 1];
      if (!lastAttempt.success) {
        return {
          shouldProceed: false,
          reason: 'identical_failed_attempts',
          suggestion: this.getSuggestionForError(lastAttempt.errorType),
        };
      }
    }

    // Check 2: Too many failures on this file
    const recentFailures = recentAttempts.filter((a) => !a.success);
    if (recentFailures.length >= MAX_FAILED_ATTEMPTS_PER_FILE) {
      return {
        shouldProceed: false,
        reason: 'too_many_failures',
        suggestion:
          'Multiple edit attempts have failed on this file. Consider:\n' +
          '1. Use read_file to re-read the current file content\n' +
          '2. Use write_file to completely replace the file content\n' +
          '3. Break the edit into smaller, more targeted changes',
      };
    }

    // Check 3: Content staleness (if we have current content to compare)
    if (
      currentContent !== null &&
      this.isContentStale(filePath, currentContent)
    ) {
      return {
        shouldProceed: true, // Allow but warn
        reason: 'stale_content',
        suggestion:
          'The file content may have changed since last read. ' +
          'Consider using read_file to get the latest content before editing.',
      };
    }

    // Check 4: old_string expects content but file is empty
    if (oldString !== '' && currentContent === '') {
      return {
        shouldProceed: false,
        reason: 'empty_file_with_old_string',
        suggestion:
          'The file is empty but old_string expects content to replace. ' +
          'Use old_string="" to create new content in an empty file, ' +
          'or use write_file to write the complete file content.',
      };
    }

    return { shouldProceed: true };
  }

  /**
   * Gets a suggestion message based on the error type.
   */
  private getSuggestionForError(errorType: ToolErrorType | null): string {
    switch (errorType) {
      case ToolErrorType.EDIT_NO_OCCURRENCE_FOUND:
        return (
          'The old_string was not found in the file. Try:\n' +
          '1. Use read_file to see the current file content\n' +
          '2. Include more context (3+ lines before and after)\n' +
          '3. Check for whitespace/indentation differences\n' +
          '4. Use write_file to replace the entire file if needed'
        );

      case ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH:
        return (
          'The old_string matched a different number of times than expected. Try:\n' +
          '1. Add more unique context to make the match specific\n' +
          '2. Use expected_replacements parameter if replacing multiple occurrences\n' +
          '3. Include function/class names or unique identifiers in old_string'
        );

      case ToolErrorType.EDIT_NO_CHANGE:
        return (
          'The edit resulted in no changes. The file already contains the new content. ' +
          'Verify the edit is still needed.'
        );

      default:
        return (
          'The edit failed multiple times with the same parameters. Consider:\n' +
          '1. Re-reading the file with read_file\n' +
          '2. Using write_file to replace the entire file\n' +
          '3. Breaking the edit into smaller changes'
        );
    }
  }

  /**
   * Gets statistics about edit attempts for a file.
   */
  getFileStats(filePath: string): {
    totalAttempts: number;
    recentFailures: number;
    recentSuccesses: number;
  } {
    const fileAttempts = this.attempts.get(filePath) || [];
    const now = Date.now();
    const recentAttempts = fileAttempts.filter(
      (a) => now - a.timestamp < FAILURE_WINDOW_MS,
    );

    return {
      totalAttempts: recentAttempts.length,
      recentFailures: recentAttempts.filter((a) => !a.success).length,
      recentSuccesses: recentAttempts.filter((a) => a.success).length,
    };
  }

  /**
   * Clears tracking data for a specific file.
   */
  clearFile(filePath: string): void {
    this.attempts.delete(filePath);
    this.lastKnownContent.delete(filePath);
  }

  /**
   * Resets all tracking data.
   */
  reset(): void {
    this.attempts.clear();
    this.lastKnownContent.clear();
  }
}

// Singleton instance for global tracking
let globalInstance: EditRetryTracker | null = null;

export function getEditRetryTracker(): EditRetryTracker {
  if (!globalInstance) {
    globalInstance = new EditRetryTracker();
  }
  return globalInstance;
}

export function resetEditRetryTracker_TEST_ONLY(): void {
  globalInstance = null;
}

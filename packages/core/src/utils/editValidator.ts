/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Result of edit validation check
 */
export interface EditValidationResult {
  isValid: boolean;
  reason?: string;
  suggestion?: string;
  errorCode?: EditValidationErrorCode;
}

/**
 * Error codes for edit validation failures
 */
export enum EditValidationErrorCode {
  EMPTY_FILE_NON_EMPTY_OLD_STRING = 'empty_file_non_empty_old_string',
  OLD_STRING_TOO_LONG = 'old_string_too_long',
  NO_COMMON_SUBSTRING = 'no_common_substring',
  BINARY_CONTENT_DETECTED = 'binary_content_detected',
  OLD_STRING_IS_WHITESPACE_ONLY = 'old_string_is_whitespace_only',
}

/**
 * Minimum length of substring to check for common content
 */
const MIN_COMMON_SUBSTRING_LENGTH = 8;

/**
 * Maximum ratio of old_string length to file content length
 * If old_string is more than 2x the file size, it's likely impossible
 */
const MAX_OLD_STRING_RATIO = 2.0;

/**
 * Validates whether an edit operation is likely to succeed.
 * This performs fast, heuristic checks to detect obviously impossible edits
 * before attempting expensive LLM correction.
 *
 * @param fileContent - Current content of the file
 * @param oldString - The string to search for
 * @param newString - The replacement string
 * @returns Validation result indicating if the edit is likely possible
 */
export function validateEditPossibility(
  fileContent: string,
  oldString: string,
  _newString: string,
): EditValidationResult {
  // Check 1: Empty file with non-empty old_string
  if (fileContent.trim() === '' && oldString.trim() !== '') {
    return {
      isValid: false,
      reason: 'Cannot find content in an empty file',
      suggestion:
        'The file is empty. Use old_string="" to create new content, or verify you are editing the correct file.',
      errorCode: EditValidationErrorCode.EMPTY_FILE_NON_EMPTY_OLD_STRING,
    };
  }

  // Check 2: old_string is significantly longer than file content
  if (
    fileContent.length > 0 &&
    oldString.length > fileContent.length * MAX_OLD_STRING_RATIO
  ) {
    return {
      isValid: false,
      reason: `old_string (${oldString.length} chars) is much longer than file content (${fileContent.length} chars)`,
      suggestion:
        'The old_string is longer than the file. Re-read the file to get the current content.',
      errorCode: EditValidationErrorCode.OLD_STRING_TOO_LONG,
    };
  }

  // Check 3: No common substring (for non-trivial old_string)
  if (
    oldString.length >= MIN_COMMON_SUBSTRING_LENGTH &&
    fileContent.length > 0
  ) {
    const hasCommonSubstring = findCommonSubstring(
      fileContent,
      oldString,
      MIN_COMMON_SUBSTRING_LENGTH,
    );
    if (!hasCommonSubstring) {
      // Extract first meaningful line for hint
      const firstLine = oldString.split('\n')[0].trim().substring(0, 50);
      return {
        isValid: false,
        reason: `No common content found between old_string and file`,
        suggestion: `The file does not contain any part of "${firstLine}...". Re-read the file to verify its current content.`,
        errorCode: EditValidationErrorCode.NO_COMMON_SUBSTRING,
      };
    }
  }

  // Check 4: Binary content detection (null bytes or high non-printable ratio)
  if (isBinaryContent(fileContent)) {
    return {
      isValid: false,
      reason: 'File appears to contain binary content',
      suggestion:
        'This file contains binary data and cannot be edited as text. Use appropriate binary tools instead.',
      errorCode: EditValidationErrorCode.BINARY_CONTENT_DETECTED,
    };
  }

  // Check 5: old_string is only whitespace (likely a mistake)
  if (oldString.length > 0 && oldString.trim() === '') {
    return {
      isValid: false,
      reason: 'old_string contains only whitespace',
      suggestion:
        'The old_string contains only whitespace characters. This is likely a mistake. Provide the actual text to replace.',
      errorCode: EditValidationErrorCode.OLD_STRING_IS_WHITESPACE_ONLY,
    };
  }

  return { isValid: true };
}

/**
 * Checks if there's a common substring of at least minLength between two strings
 */
function findCommonSubstring(
  content: string,
  search: string,
  minLength: number,
): boolean {
  // Normalize both strings for comparison
  const normalizedContent = content.toLowerCase();
  const normalizedSearch = search.toLowerCase();

  // Try to find any substring of minLength from search in content
  for (let i = 0; i <= normalizedSearch.length - minLength; i++) {
    const substring = normalizedSearch.substring(i, i + minLength);
    // Skip if substring is mostly whitespace
    if (substring.trim().length < minLength / 2) continue;
    if (normalizedContent.includes(substring)) {
      return true;
    }
  }

  // Also check individual lines (for multiline content)
  const searchLines = search
    .split('\n')
    .filter((line) => line.trim().length > 0);
  for (const line of searchLines) {
    const trimmedLine = line.trim();
    if (trimmedLine.length >= minLength) {
      const checkPortion = trimmedLine.substring(
        0,
        Math.min(minLength * 2, trimmedLine.length),
      );
      if (normalizedContent.includes(checkPortion.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Detects if content appears to be binary (non-text)
 */
function isBinaryContent(content: string): boolean {
  // Check for null bytes (strong indicator of binary)
  if (content.includes('\0')) {
    return true;
  }

  // Check ratio of non-printable characters
  const nonPrintable = content.split('').filter((char) => {
    const code = char.charCodeAt(0);
    // Allow common whitespace and printable ASCII, plus common Unicode
    return (
      code < 9 || // Before tab
      (code > 13 && code < 32) || // Between CR and space (excluding common control chars)
      (code >= 127 && code <= 159) // DEL and C1 control characters
    );
  }).length;

  // If more than 10% non-printable, likely binary
  return content.length > 0 && nonPrintable / content.length > 0.1;
}

/**
 * Tracks edit attempts for a specific file to detect retry patterns
 */
export interface EditAttemptInfo {
  filePath: string;
  oldString: string;
  newString: string;
  timestamp: number;
  success: boolean;
  errorCode?: string;
}

/**
 * Retry tracking result
 */
export interface RetryCheckResult {
  shouldBlock: boolean;
  reason?: string;
  suggestion?: string;
  consecutiveFailures: number;
  totalFailures: number;
}

/**
 * Service to track edit attempts and detect problematic retry patterns
 */
export class EditRetryTracker {
  private attempts: Map<string, EditAttemptInfo[]> = new Map();
  private readonly maxAttempts: number;
  private readonly maxConsecutiveIdentical: number;
  private readonly attemptWindowMs: number;

  constructor(
    maxAttempts = 5,
    maxConsecutiveIdentical = 2,
    attemptWindowMs = 300000, // 5 minutes
  ) {
    this.maxAttempts = maxAttempts;
    this.maxConsecutiveIdentical = maxConsecutiveIdentical;
    this.attemptWindowMs = attemptWindowMs;
  }

  /**
   * Records an edit attempt
   */
  recordAttempt(
    filePath: string,
    oldString: string,
    newString: string,
    success: boolean,
    errorCode?: string,
  ): void {
    const attempts = this.attempts.get(filePath) || [];
    attempts.push({
      filePath,
      oldString,
      newString,
      timestamp: Date.now(),
      success,
      errorCode,
    });

    // Keep only recent attempts within the window
    const cutoff = Date.now() - this.attemptWindowMs;
    const recentAttempts = attempts.filter((a) => a.timestamp > cutoff);
    this.attempts.set(filePath, recentAttempts);
  }

  /**
   * Checks if a new edit attempt should be blocked based on retry patterns
   */
  checkRetryPattern(
    filePath: string,
    oldString: string,
    newString: string,
  ): RetryCheckResult {
    const attempts = this.attempts.get(filePath) || [];
    const cutoff = Date.now() - this.attemptWindowMs;
    const recentAttempts = attempts.filter((a) => a.timestamp > cutoff);
    const failedAttempts = recentAttempts.filter((a) => !a.success);

    // Check for consecutive identical failed attempts
    let consecutiveIdentical = 0;
    for (let i = recentAttempts.length - 1; i >= 0; i--) {
      const attempt = recentAttempts[i];
      if (
        !attempt.success &&
        attempt.oldString === oldString &&
        attempt.newString === newString
      ) {
        consecutiveIdentical++;
      } else {
        break;
      }
    }

    if (consecutiveIdentical >= this.maxConsecutiveIdentical) {
      return {
        shouldBlock: true,
        reason: `Same edit has failed ${consecutiveIdentical} times consecutively`,
        suggestion:
          'Stop retrying the same edit. Re-read the file to get current content, or use a different approach.',
        consecutiveFailures: consecutiveIdentical,
        totalFailures: failedAttempts.length,
      };
    }

    // Check for too many total failures on this file
    if (failedAttempts.length >= this.maxAttempts) {
      return {
        shouldBlock: true,
        reason: `${failedAttempts.length} edit failures on this file in the last ${this.attemptWindowMs / 60000} minutes`,
        suggestion:
          'Multiple edits have failed on this file. Consider using write_file to replace the entire content, or verify the file path is correct.',
        consecutiveFailures: consecutiveIdentical,
        totalFailures: failedAttempts.length,
      };
    }

    return {
      shouldBlock: false,
      consecutiveFailures: consecutiveIdentical,
      totalFailures: failedAttempts.length,
    };
  }

  /**
   * Clears tracking data for a specific file
   */
  clearFile(filePath: string): void {
    this.attempts.delete(filePath);
  }

  /**
   * Clears all tracking data
   */
  clearAll(): void {
    this.attempts.clear();
  }

  /**
   * Gets statistics for a file
   */
  getStats(filePath: string): {
    totalAttempts: number;
    failedAttempts: number;
    successfulAttempts: number;
  } {
    const attempts = this.attempts.get(filePath) || [];
    const cutoff = Date.now() - this.attemptWindowMs;
    const recentAttempts = attempts.filter((a) => a.timestamp > cutoff);

    return {
      totalAttempts: recentAttempts.length,
      failedAttempts: recentAttempts.filter((a) => !a.success).length,
      successfulAttempts: recentAttempts.filter((a) => a.success).length,
    };
  }
}

// Singleton instance for global retry tracking
let globalRetryTracker: EditRetryTracker | null = null;

export function getGlobalRetryTracker(): EditRetryTracker {
  if (!globalRetryTracker) {
    globalRetryTracker = new EditRetryTracker();
  }
  return globalRetryTracker;
}

export function resetGlobalRetryTracker(): void {
  globalRetryTracker = null;
}

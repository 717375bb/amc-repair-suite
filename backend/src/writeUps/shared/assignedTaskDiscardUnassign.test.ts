import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUnassignForUsageRemaining, USAGE_REMAINING_UNASSIGN_THRESHOLD_CYCLES } from './assignedTaskDiscardUnassign.js';

test('shouldUnassignForUsageRemaining — over threshold unassigns', () => {
  assert.equal(shouldUnassignForUsageRemaining(39286), true);
  assert.equal(shouldUnassignForUsageRemaining(USAGE_REMAINING_UNASSIGN_THRESHOLD_CYCLES + 1), true);
});

test('shouldUnassignForUsageRemaining — at or under threshold does not unassign', () => {
  assert.equal(shouldUnassignForUsageRemaining(USAGE_REMAINING_UNASSIGN_THRESHOLD_CYCLES), false);
  assert.equal(shouldUnassignForUsageRemaining(500), false);
  assert.equal(shouldUnassignForUsageRemaining(0), false);
});

test('shouldUnassignForUsageRemaining — null (unparsed) never unassigns', () => {
  assert.equal(shouldUnassignForUsageRemaining(null), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {taskBlockerDisplay} from '../src/owner/task-blocker-display.mjs';
const detail = '  纸张晚到；已换用备用纸。  ';
test('a terminal outcome keeps the reported obstacle as context without reopening work', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    assert.deepEqual(taskBlockerDisplay(status, detail), {active:'', note:detail});
  }
});
test('an open task keeps its actual blocker, including when waiting for a decision', () => {
  for (const status of ['proposed', 'running', 'needs_input']) {
    assert.deepEqual(taskBlockerDisplay(status, detail), {active:detail, note:''});
  }
});
test('missing or blank detail creates neither a blocker nor a note', () => {
  for (const status of ['proposed','running','needs_input','completed','failed','cancelled']) {
    for (const value of [null, undefined, '', ' \t ', 12, {}]) {
      assert.deepEqual(taskBlockerDisplay(status, value), {active:'', note:''});
    }
  }
});

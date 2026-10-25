import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attempt, validSecret, type BanState } from '../src/auth-policy.ts';

test('minimum secret length is ten Unicode characters; maximum is bounded', () => {
  assert.equal(validSecret('123456789'), false);
  assert.equal(validSecret('1234567890'), true);
  assert.equal(validSecret('😀'.repeat(5)), false);
  assert.equal(validSecret('😀'.repeat(10)), true);
  assert.equal(validSecret('a'.repeat(4097)), false);
});
test('five failures per strike escalate to permanent; banned requests never extend or bypass a ban', () => {
  let state: BanState = { failures: 0, strikes: 0, until: 0 };
  let now = 1000;
  for (const duration of [60000, 900000, 86400000, -1]) {
    for (let i = 0; i < 5; i++) state = attempt(state, false, now).state;
    assert.equal(state.until, duration === -1 ? -1 : now + duration);
    const blocked = attempt(state, true, now);
    assert.equal(blocked.allowed, false);
    assert.deepEqual(blocked.state, state);
    now += duration > 0 ? duration + 1 : 1;
  }
  assert.equal(attempt(state, true, Number.MAX_SAFE_INTEGER).allowed, false);
});
test('successful authentication resets consecutive failures but retains escalation history', () => {
  const previous = { failures: 4, strikes: 2, until: 500 };
  const result = attempt(previous, true, 1000);
  assert.equal(result.allowed, true);
  assert.equal(result.state.failures, 0);
  assert.equal(result.state.strikes, 2);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBestMatch } from '../pickBestMatch.mjs';

// Minimal match factory — only the fields pickBestMatch uses for ranking.
const match = (identity, qcovs, species = 'Species A') =>
  ({ identity, qcovs, species });

// ── Rule: sort by identity descending ────────────────────────────────────────

test('higher identity ranks first', () => {
  const result = pickBestMatch('id1', [match(97, 100), match(100, 100)]);
  assert.equal(result[0].identity, 100);
  assert.equal(result[1].identity, 97);
});

test('returns empty array when there are no matches', () => {
  assert.deepEqual(pickBestMatch('id1', []), []);
});

test('returns single match unchanged', () => {
  const m = match(95, 80);
  assert.deepEqual(pickBestMatch('id1', [m]), [m]);
});

// ── Rule: qcovs tiebreaker when identity is tied ──────────────────────────────

test('higher qcovs wins when identity is tied', () => {
  const result = pickBestMatch('id1', [
    match(100, 89.3, 'Low coverage species'),
    match(100, 100,  'High coverage species'),
  ]);
  assert.equal(result[0].species, 'High coverage species');
  assert.equal(result[1].species, 'Low coverage species');
});

test('identity takes precedence over qcovs', () => {
  const result = pickBestMatch('id1', [
    match(99, 100, 'High coverage but lower identity'),
    match(100, 50, 'Low coverage but higher identity'),
  ]);
  assert.equal(result[0].species, 'Low coverage but higher identity');
});

// ── topN limit ────────────────────────────────────────────────────────────────

test('returns at most topN matches', () => {
  const matches = [95, 96, 97, 98, 99, 100].map(i => match(i, 100));
  assert.equal(pickBestMatch('id1', matches).length, 5);
});

test('topN can be overridden', () => {
  const matches = [95, 96, 97, 98, 99, 100].map(i => match(i, 100));
  assert.equal(pickBestMatch('id1', matches, {}, 3).length, 3);
});

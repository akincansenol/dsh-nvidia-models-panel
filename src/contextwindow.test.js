// Unit tests for inferContextWindow (the fix for the false CONTEXT_WINDOW_EXCEEDED).
// Run: ELECTRON_RUN_AS_NODE=1 "<DSH_NODE_EXECUTABLE>" --test src/contextwindow.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { inferContextWindow } from './index.js';

test('inferContextWindow: upstream value wins when reported', () => {
  assert.equal(inferContextWindow('deepseek-ai/deepseek-v4.1-flash', 1048576), 1048576);
  assert.equal(inferContextWindow('weird/model', 2097152), 2097152);
  assert.equal(inferContextWindow('weird/model', 40000), 40000);
});

test('inferContextWindow: never falls back to the old 128K default', () => {
  const W = inferContextWindow('meta/llama-3.1-8b', undefined);
  assert.ok(W > 131072, 'declared window must exceed legacy 128K, got ' + W);
  assert.equal(W, 1048576);
});

test('inferContextWindow: known long-context families get 1M', () => {
  assert.equal(inferContextWindow('nvidia/nemotron-3-ultra-550b-a55b'), 1048576);
  assert.equal(inferContextWindow('deepseek-ai/deepseek-v4.1-flash'), 1048576);
  assert.equal(inferContextWindow('mistralai/mistral-large-4-1t-a52b'), 1048576);
});

test('inferContextWindow: other chat families get 256K', () => {
  assert.equal(inferContextWindow('nvidia/nemotron-3.5-lightning-30b-a3b'), 262144);
  assert.equal(inferContextWindow('z-ai/glm-5.3-flash'), 262144);
  assert.equal(inferContextWindow('stepfun-ai/step-5-preview'), 262144);
});

test('inferContextWindow: unknown ids fall back to the loose default', () => {
  assert.equal(inferContextWindow('totally-unknown-model'), 1048576);
  assert.equal(inferContextWindow(undefined), 1048576);
});

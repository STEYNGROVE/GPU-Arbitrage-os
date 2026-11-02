import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderDeployService } from '../server/renderDeployService.ts';

test('Render Deploy Service: Validates and sets hook URL', () => {
  const sampleUrl = 'https://api.render.com/deploy/srv-c1234567890abcdef?key=secretkey123';
  const result = renderDeployService.setHookUrl(sampleUrl);
  assert.equal(result.success, true);
  assert.equal(renderDeployService.getHookUrl(), sampleUrl);

  const status = renderDeployService.getStatus();
  assert.equal(status.configured, true);
  assert.ok(!status.maskedUrl.includes('secretkey123'), 'Masked URL must never expose raw key');
  assert.ok(status.maskedUrl.includes('api.render.com'), 'Masked URL must preserve hostname');
});

test('Render Deploy Service: Rejects invalid non-HTTP/HTTPS URLs', () => {
  const invalidResult = renderDeployService.setHookUrl('ftp://invalid-url');
  assert.equal(invalidResult.success, false);
  assert.ok(invalidResult.error?.includes('HTTPS'));
});

test('Render Deploy Service: Supports clearing hook', () => {
  const clearResult = renderDeployService.setHookUrl('');
  assert.equal(clearResult.success, true);
  assert.equal(renderDeployService.getHookUrl(), '');
  assert.equal(renderDeployService.getStatus().configured, false);
});

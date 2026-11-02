import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatGptGithubService } from '../server/chatgptGithubService.ts';

test('ChatGPT-GitHub Service: generates valid OpenAPI 3.1.0 specification', () => {
  const spec = chatGptGithubService.generateOpenApiSpec('http://localhost:3000') as any;
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.info.title, 'GPU Compute Arbitrage OS - GitHub Bridge API');
  assert.ok(spec.paths['/api/chatgpt/status']);
  assert.ok(spec.paths['/api/chatgpt/file']);
  assert.ok(spec.paths['/api/chatgpt/tree']);
  assert.ok(spec.paths['/api/chatgpt/commits']);
  assert.ok(spec.paths['/api/chatgpt/opportunities']);
  assert.ok(spec.paths['/api/chatgpt/audit-note']);
});

test('ChatGPT-GitHub Service: safely reads repo files and blocks directory traversal', () => {
  const pkgRead = chatGptGithubService.getFileContent('package.json');
  assert.equal(pkgRead.success, true);
  assert.ok(pkgRead.content && pkgRead.content.includes('react-example'));

  // Test traversal block
  const traversalRead = chatGptGithubService.getFileContent('../../../etc/passwd');
  assert.equal(traversalRead.success, false);

  // Test secret file block
  const envRead = chatGptGithubService.getFileContent('.env');
  assert.equal(envRead.success, false);
});

test('ChatGPT-GitHub Service: lists repository tree with core source files', () => {
  const tree = chatGptGithubService.getRepositoryTree();
  assert.ok(tree.includes('server.ts'), 'server.ts missing from tree');
  assert.ok(tree.includes('Dockerfile'), 'Dockerfile missing from tree');
  assert.ok(tree.includes('package.json'), 'package.json missing from tree');
  assert.ok(!tree.some((f) => f.includes('node_modules')), 'node_modules should not be in tree');
});

test('ChatGPT-GitHub Service: returns target repo metadata', async () => {
  const status = await chatGptGithubService.getStatus('http://localhost:3000');
  assert.equal(status.github.targetRepo, 'STEYNGROVE/gpu-compute-arbitrage-os-and-connect-it-to-Render.');
  assert.equal(status.github.branch, 'main');
  assert.equal(status.chatGptIntegration.status, 'ACTIVE');
});

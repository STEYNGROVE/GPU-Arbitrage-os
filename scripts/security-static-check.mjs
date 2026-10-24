import fs from 'node:fs';
import path from 'node:path';

const failures = [];
const root = process.cwd();
const scanExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.conf', '.yml', '.yaml', '.json', '.md', '.example']);
const forbidden = [
  ['legacy bridge token', /7f3c82e1d094bba891c6e432a10d9f8b/],
  ['hardcoded production database password', /arbitrage_prod_secure_pass_v13/],
  ['hardcoded PayFast sandbox passphrase', /payfast_sandbox_passphrase_v14/],
];
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'build'].includes(item.name)) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full);
    else if (scanExtensions.has(path.extname(item.name)) || item.name === '.env.example') {
      const text = fs.readFileSync(full, 'utf8');
      for (const [label, pattern] of forbidden) if (pattern.test(text)) failures.push(`${full}: ${label} still present`);
    }
  }
}
walk(root);
if (!fs.existsSync(path.join(root, 'Dockerfile'))) failures.push('Dockerfile is missing');
const compose = fs.readFileSync(path.join(root, 'docker-compose.prod.yml'), 'utf8');
if (/"5432:5432"|'5432:5432'/.test(compose)) failures.push('PostgreSQL port is published to the host');
const gpu = fs.readFileSync(path.join(root, 'server/gpuArbitrageService.ts'), 'utf8');
if (/quoteSource:\s*'BENCHMARK_CATALOG',[\s\S]{0,260}?isExecutable:\s*true/.test(gpu)) failures.push('A benchmark quote is marked executable');
if (failures.length) {
  console.error('Security static check FAILED:\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log('Security static check passed: no known hardcoded secrets, database is not host-published, Dockerfile exists, benchmark quotes are non-executable.');

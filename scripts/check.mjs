import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = ['server.mjs', ...['src', 'scripts', 'tests', 'public'].flatMap(folder =>
  readdirSync(folder).filter(name => /\.(mjs|js)$/.test(name)).map(name => folder + '/' + name))];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('所有 JavaScript 文件语法检查通过。');

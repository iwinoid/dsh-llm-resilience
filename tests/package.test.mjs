import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根目录。 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 读取 JSON 文件。 */
function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));
}

/** 包内文件是否存在。 */
function exists(relativePath) {
  return existsSync(join(ROOT, relativePath));
}

/** 列出 lib 下的所有 JS 文件。 */
function libFiles() {
  return readdirSync(join(ROOT, 'lib')).filter(name => name.endsWith('.js')).sort();
}

test('package.json：manifest 字段与 bundle/client 清单完整', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.name, 'dsh-llm-resilience');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);
  assert.equal(pkg.main, 'lib/index.js');
  assert.equal(pkg.exports['.'], './lib/index.js');
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.equal(pkg.exports['./icon'], './icon.svg');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(Array.isArray(pkg.dsh.client.inject));
  assert.ok(exists(pkg.main), 'main 文件存在');
  assert.ok(exists(pkg.dsh.bundle.patch), 'bundle patch 文件存在');
  assert.ok(exists('lib/client.js'), 'client 入口存在');
  assert.ok(exists('lib/policy.js'), '策略引擎存在');
  assert.ok(exists('lib/escalation.js'), '升级续重试处理器存在');
  assert.ok(exists('icon.svg'), '图标存在');
  assert.ok(exists('locale/en.json') && exists('locale/zh.json'), '双语 locale 存在');
  assert.ok(exists('README.md'), 'README 存在');
  assert.ok(exists('docs/IMPLEMENTATION.md'), '实现文档存在');
  // files 覆盖全部运行时文件与资源。
  for (const required of [
    'lib/index.js',
    'lib/client.js',
    'lib/policy.js',
    'lib/escalation.js',
    'cordis.patch.yml',
    'locale/*.json',
    'icon.svg',
    'README.md',
    'docs/IMPLEMENTATION.md',
  ]) {
    assert.ok(pkg.files.includes(required), `files 覆盖 ${required}`);
  }
  // 依赖只声明 schemastery（Config schema 需要），不引入宿主包。
  assert.deepEqual(Object.keys(pkg.dependencies), ['@deepseek-ai/schemastery']);
});

test('cordis.patch.yml：bundle 行 id/name 正确且只有一条 insert', () => {
  const text = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
  // 未注释的有效行：一条 insert，内含一条 id/name 行。
  const activeLines = text.split('\n')
    .filter(line => !/^\s*#/.test(line) && line.trim() !== '')
    .map(line => line.trim());
  assert.deepEqual(activeLines, [
    '- insert:',
    '- id: llm-resilience',
    'name: dsh-llm-resilience',
  ]);
  assert.equal((text.match(/^\s*- insert:/gm) ?? []).length, 1);
});

test('locale：中英文 meta.title/description 均存在且不重复', () => {
  const en = readJson('locale/en.json');
  const zh = readJson('locale/zh.json');
  for (const [locale, doc] of [['en', en], ['zh', zh]]) {
    assert.equal(typeof doc.meta.title, 'string', `${locale} title`);
    assert.equal(typeof doc.meta.description, 'string', `${locale} description`);
    assert.ok(doc.meta.title.length > 0 && doc.meta.description.length > 0, `${locale} 文案非空`);
    assert.ok(doc.meta.title.length <= 80, `${locale} title 长度上限`);
    assert.ok(doc.meta.description.length <= 300, `${locale} description 长度上限`);
  }
  assert.notEqual(en.meta.title, zh.meta.title);
});

test('icon.svg：合法 SVG、体积在 256KiB 以内', () => {
  const path = join(ROOT, 'icon.svg');
  const text = readFileSync(path, 'utf8');
  assert.match(text.trimStart(), /^(<\?xml[^>]*>\s*)?<svg[\s>]/, 'SVG 根元素');
  assert.ok(text.length < 256 * 1024, '图标体积上限');
  assert.ok(statSync(path).size > 0, '图标非空');
});

test('lib 下每个 JS 文件都通过 node --check', () => {
  const files = libFiles();
  assert.ok(files.includes('index.js') && files.includes('client.js') && files.includes('policy.js') && files.includes('escalation.js'));
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', join(ROOT, 'lib', file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `node --check lib/${file} 失败：${result.stderr}`);
  }
});

test('Host 入口导出约定：name/inject/Config/apply，且无 default export', () => {
  const text = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');
  assert.match(text, /^export const name = 'dsh-llm-resilience'/m);
  assert.match(text, /^export const inject = \['settings'\]/m);
  assert.match(text, /^export const Config = z\.object\(/m);
  assert.match(text, /^export function apply\(ctx, config\)/m);
  assert.doesNotMatch(text, /^export default /m);
});

test('客户端入口：动态模块注册 plugins.row.config 配置页', () => {
  const text = readFileSync(join(ROOT, 'lib/client.js'), 'utf8');
  assert.match(text, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(text, /id: 'dsh-llm-resilience'/);
  assert.match(text, /inject = \['slots', 'locale', 'configForms'\]/);
  assert.match(text, /slots\.inject\(/);
  assert.match(text, /'plugins\.row\.config'/);
  assert.match(text, /key: 'dsh-llm-resilience#' \+ ENTRY_ID/);
  // 页面从 owner props 拿到 { view, form }，读 llm-pi-ai 命名空间。
  assert.match(text, /props\.view/);
  assert.match(text, /props\.form/);
  assert.match(text, /configForms\.get\(PI_ENTRY\)/);
  // 只写白名单字段。
  assert.match(text, /streamIdleTimeoutMs/);
  assert.match(text, /retryPolicy/);
  assert.match(text, /timeoutMs/);
  assert.doesNotMatch(text, /'reasoning'|'baseURL'|'apiKeyEnv'/);
  // 客户端模块不得 import 任何宿主 Client 包。
  assert.doesNotMatch(text, /from '@deepseek-ai\//);
  assert.doesNotMatch(text, /require\('@deepseek-ai\//);
});

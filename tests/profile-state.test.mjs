import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLUGIN_NAME,
  ROW_ID,
  analyzeProfileState,
  findRowBlocks,
  profileDir,
  readProfileState,
  removeRowBlocks,
  writePatchWithBackup,
} from '../scripts/profile-state.mjs';

/** 造一个临时 profile 目录（含 package.json / cordis.patch.yml）。 */
function fixture({ bundles, dependency = `link:/tmp/${PLUGIN_NAME}`, patch }) {
  const dir = mkdtempSync(join(tmpdir(), 'llr-profile-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies: { [PLUGIN_NAME]: dependency }, dsh: { profile: { bundles } } }, null, 2));
  if (patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), patch, { mode: 0o600 });
  return dir;
}

const ENABLED = [ '@deepseek-ai/dsh-base', PLUGIN_NAME ];
const DISABLED = [ '@deepseek-ai/dsh-base' ];

test('profileDir：优先 DSH_HOME，缺省回落到 ~/.dsh', () => {
  assert.match(profileDir('web', { DSH_HOME: '/tmp/x' }), /^\/tmp\/x\/profiles\/web$/);
  assert.match(profileDir('web', {}), /\/\.dsh\/profiles\/web$/);
});

test('readProfileState：读出 bundles、依赖与 patch 文本', () => {
  const dir = fixture({ bundles: DISABLED, patch: '[]\n' });
  try {
    const state = readProfileState(dir);
    assert.deepEqual(state.bundles, DISABLED);
    assert.equal(state.dependency, `link:/tmp/${PLUGIN_NAME}`);
    assert.equal(state.patchText, '[]\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findRowBlocks：只命中第 0 列的 - id 项，不碰 insert 子项', () => {
  const patch = [
    '- insert:',
    `    - id: ${ROW_ID}`,
    '      name: dsh-llm-resilience',
    '- id: other',
    '  name: other',
    `- id: ${ROW_ID}`,
    '  name: dsh-llm-resilience',
    '  config:',
    '    escalatedRetries: 3',
    '',
    '- id: ui-theme',
    '  config: {}',
    '',
  ].join('\n');
  const blocks = findRowBlocks(patch);
  assert.equal(blocks.length, 1);
  const [block] = blocks;
  assert.equal(block.start, 5);
  assert.deepEqual(block.lines, [
    `- id: ${ROW_ID}`,
    '  name: dsh-llm-resilience',
    '  config:',
    '    escalatedRetries: 3',
  ]);
});

test('findRowBlocks：引号 id 与尾注释也能识别', () => {
  const patch = ['- id: "llm-resilience"  # 用户层覆盖', '  config: {}', '- id: next', ''].join('\n');
  const blocks = findRowBlocks(patch);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].start, 0);
  assert.equal(blocks[0].end, 2);
});

test('findRowBlocks：没有目标项时返回空数组', () => {
  assert.deepEqual(findRowBlocks('- id: other\n  config: {}\n'), []);
  assert.deepEqual(findRowBlocks(''), []);
});

test('removeRowBlocks：只删目标块，其余内容与顺序不变', () => {
  const patch = [
    '- insert:',
    `    - id: ${ROW_ID}`,
    '- id: llm-resilience',
    '  config:',
    '    escalatedRetries: 3',
    '',
    '- id: ui-theme',
    '  config: {}',
    '',
  ].join('\n');
  const next = removeRowBlocks(patch, findRowBlocks(patch));
  assert.ok(!next.includes('escalatedRetries'));
  assert.ok(next.includes('    - id: llm-resilience'), 'insert 子项必须保留');
  assert.ok(next.includes('- id: ui-theme'));
  assert.ok(!/\n{3,}/.test(next), '不留连续空行');
});

test('removeRowBlocks：空块列表是恒等变换', () => {
  const patch = '- id: x\n  config: {}\n';
  assert.equal(removeRowBlocks(patch, []), patch);
});

test('analyzeProfileState：未启用且无残留 → 无问题', () => {
  const dir = fixture({ bundles: DISABLED, patch: '- id: ui-theme\n  config: {}\n' });
  try {
    const analysis = analyzeProfileState(readProfileState(dir));
    assert.equal(analysis.mode, 'disabled');
    assert.deepEqual(analysis.problems, []);
    assert.ok(analysis.notes.some(note => note.includes('不会产生任何 patch 告警')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyzeProfileState：未启用 + 残留 → orphan-patch（可修）', () => {
  const dir = fixture({
    bundles: DISABLED,
    patch: `- id: ${ROW_ID}\n  name: dsh-llm-resilience\n  config:\n    escalatedRetries: 3\n`,
  });
  try {
    const analysis = analyzeProfileState(readProfileState(dir));
    assert.equal(analysis.mode, 'disabled');
    assert.equal(analysis.problems.length, 1);
    assert.equal(analysis.problems[0].code, 'orphan-patch');
    assert.equal(analysis.problems[0].fixable, true);
    assert.ok(analysis.problems[0].message.includes('not found'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyzeProfileState：已启用 + 用户层配置是正常覆盖，不算问题', () => {
  const dir = fixture({
    bundles: ENABLED,
    patch: `- id: ${ROW_ID}\n  name: dsh-llm-resilience\n  config:\n    escalatedRetries: 3\n`,
  });
  try {
    const analysis = analyzeProfileState(readProfileState(dir));
    assert.equal(analysis.mode, 'enabled');
    assert.deepEqual(analysis.problems, []);
    assert.ok(analysis.notes.some(note => note.includes('属正常')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyzeProfileState：依赖缺失是问题（两种形态都报）', () => {
  const dir = fixture({ bundles: DISABLED, dependency: '', patch: '' });
  try {
    const analysis = analyzeProfileState(readProfileState(dir));
    assert.equal(analysis.problems[0].code, 'dependency-missing');
    assert.equal(analysis.problems[0].fixable, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyzeProfileState：patch 文件不存在时按空处理', () => {
  const dir = fixture({ bundles: DISABLED });
  try {
    const analysis = analyzeProfileState(readProfileState(dir));
    assert.deepEqual(analysis.problems, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writePatchWithBackup：先备份、再原子写回，内容与权限正确', () => {
  const dir = fixture({ bundles: DISABLED, patch: '[]\n' });
  try {
    const path = join(dir, 'cordis.patch.yml');
    const backup = writePatchWithBackup(path, '- id: next\n  config: {}\n');
    assert.equal(readFileSync(path, 'utf8'), '- id: next\n  config: {}\n');
    assert.equal(readFileSync(backup, 'utf8'), '[]\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('端到端：发现孤儿 → 删除 → 再分析干净', () => {
  const dir = fixture({
    bundles: DISABLED,
    patch: [
      '- insert:',
      '    - id: mcp-eutils',
      '      name: x',
      `- id: ${ROW_ID}`,
      '  name: dsh-llm-resilience',
      '  config:',
      '    defaultStreamIdleTimeoutMs: 60000',
      '',
      '- id: ui-theme',
      '  config: {}',
      '',
    ].join('\n'),
  });
  try {
    const before = analyzeProfileState(readProfileState(dir));
    assert.equal(before.problems[0].code, 'orphan-patch');
    const next = removeRowBlocks(readProfileState(dir).patchText, before.rowBlocks);
    writePatchWithBackup(join(dir, 'cordis.patch.yml'), next);
    const after = analyzeProfileState(readProfileState(dir));
    assert.deepEqual(after.problems, []);
    assert.ok(after.rowBlocks.length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

#!/usr/bin/env node
/**
 * dsh-llm-resilience 安装后 smoke 检查。
 *
 * 默认只做静态检查（不读 profile、不启动 Host）：
 *   node scripts/smoke.mjs
 *
 * 安装后可在 Lead/用户批准下加 --profile <name> 做只读检查：
 *   node scripts/smoke.mjs --profile web
 *
 * 检查分两种形态（自动识别）：
 *   - 已启用（bundle 在 dsh.profile.bundles 里）：确认依赖、bundle 行、启动补齐结果；
 *   - 未启用（只装了依赖）：确认用户层没有残留的 "- id: llm-resilience" 配置，
 *     否则 Loader 每次启动都会打印 patch: entry "llm-resilience" not found。
 *     有残留时加 --fix 可精确删除（先备份，再原子写回）。
 *
 * 除 --fix 外不写任何文件，也不会启动/重启 Host。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_NAME,
  analyzeProfileState,
  profileDir,
  readJson,
  readProfileState,
  removeRowBlocks,
  writePatchWithBackup,
} from './profile-state.mjs';

/** 包根目录。 */
const ROOT = dirname(fileURLToPath(import.meta.url));
const ROOT_PACKAGE = dirname(ROOT);

/** 检查结果。 */
const checks = [];

/**
 * 记录一条检查结果。
 * @param {string} name 检查名。
 * @param {boolean} ok 是否通过。
 * @param {string} [detail] 详情。
 */
function check(name, ok, detail) {
  checks.push({ name, ok, skipped: false, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

/**
 * 记录一条不影响失败的提示（依赖运行时条件，无法静态断言）。
 * @param {string} name 检查名。
 * @param {string} detail 详情。
 */
function skip(name, detail) {
  checks.push({ name, ok: true, skipped: true, detail });
  console.log(`SKIP  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  const args = { profile: undefined, fix: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profile') {
      args.profile = argv[index + 1];
      index += 1;
    } else if (argv[index].startsWith('--profile=')) {
      args.profile = argv[index].slice('--profile='.length);
    } else if (argv[index] === '--fix') {
      args.fix = true;
    }
  }
  return args;
}

// ---------------- 静态检查（总是执行） ----------------
const pkg = readJson(join(ROOT_PACKAGE, 'package.json'));
check('package.json 可解析', pkg !== undefined);
if (pkg !== undefined) {
  check('包名是 dsh-llm-resilience', pkg.name === 'dsh-llm-resilience', pkg.name);
  check('type=module', pkg.type === 'module');
  check('bundle patch 已声明', pkg.dsh?.bundle?.patch === './cordis.patch.yml');
  check('client platform=web', pkg.dsh?.client?.platform === 'web');
  check('exports ./client', pkg.exports?.['./client'] === './lib/client.js');
  check('exports ./icon', pkg.exports?.['./icon'] === './icon.svg');
  const required = [
    'lib/index.js',
    'lib/client.js',
    'lib/policy.js',
    'lib/escalation.js',
    'cordis.patch.yml',
    'icon.svg',
    'README.md',
    'docs/IMPLEMENTATION.md',
  ];
  for (const file of required) {
    check(`文件存在：${file}`, existsSync(join(ROOT_PACKAGE, file)));
  }
  check('icon < 256KiB', existsSync(join(ROOT_PACKAGE, 'icon.svg')) && statSync(join(ROOT_PACKAGE, 'icon.svg')).size < 256 * 1024);
  for (const locale of ['en', 'zh']) {
    const doc = readJson(join(ROOT_PACKAGE, 'locale', `${locale}.json`));
    check(`locale/${locale}.json meta 完整`, typeof doc?.meta?.title === 'string' && typeof doc?.meta?.description === 'string');
  }
  const scripts = ['lib/index.js', 'lib/client.js', 'lib/policy.js', 'lib/escalation.js', 'scripts/smoke.mjs', 'scripts/profile-state.mjs'];
  for (const file of scripts) {
    const result = spawnSync(process.execPath, ['--check', join(ROOT_PACKAGE, file)], { encoding: 'utf8' });
    check(`node --check ${file}`, result.status === 0, result.stderr.trim().split('\n')[0] ?? '');
  }
}

// ---------------- profile 检查（--profile 时执行；只在 --fix 时写盘） ----------------
const args = parseArgs(process.argv.slice(2));
if (args.profile !== undefined) {
  const dir = profileDir(args.profile);
  check(`profile 目录存在：${dir}`, existsSync(dir));
  const state = readProfileState(dir);
  check('profile package.json 可解析', state.manifest !== undefined);

  if (state.manifest !== undefined) {
    check('依赖声明指向本地包', typeof state.dependency === 'string', state.dependency);
    const analysis = analyzeProfileState(state);
    console.log(`INFO  插件形态：${analysis.enabled ? '已启用（bundle 在 dsh.profile.bundles）' : '未启用（仅装了依赖）'}`);

    const bundlePatchPath = join(ROOT_PACKAGE, 'cordis.patch.yml');
    const bundlePatch = existsSync(bundlePatchPath) ? readFileSync(bundlePatchPath, 'utf8') : '';
    check('bundle cordis.patch.yml 声明 llm-resilience 行', /id:\s*llm-resilience/.test(bundlePatch), bundlePatchPath);

    const orphan = analysis.problems.find(problem => problem.code === 'orphan-patch');
    if (analysis.enabled) {
      // 启用形态下，用户层的 llm-resilience 段是正常配置；补齐结果取决于 Host 是否已重启。
      skip('已写入 streamIdleTimeoutMs=30000（启动补齐生效）', '需在 Host 加载本插件后重新检查');
    } else if (orphan === undefined) {
      check('用户层无残留 llm-resilience 配置（启动不会产生 patch 告警）', true);
    } else if (!args.fix) {
      check('用户层无残留 llm-resilience 配置（启动不会产生 patch 告警）', false, orphan.message);
    } else {
      const next = removeRowBlocks(state.patchText, analysis.rowBlocks);
      const backup = writePatchWithBackup(state.patchPath, next);
      const after = analyzeProfileState(readProfileState(dir));
      check(
        '已删除残留 llm-resilience 配置（启动不再告警）',
        after.problems.every(problem => problem.code !== 'orphan-patch'),
        `备份：${backup}`,
      );
    }

    for (const note of analysis.notes) console.log(`INFO  ${note}`);
  }

  if (args.fix !== true) {
    console.log('\n提示：profile 检查只读；--fix 才会删除残留配置（先备份）。UI 渲染与重试行为需人工验证。');
  }
} else {
  console.log('\n提示：未指定 --profile，跳过 profile 检查。安装后可运行：node scripts/smoke.mjs --profile <name>');
}

const failed = checks.filter(entry => !entry.ok);
console.log(`\n共 ${checks.length} 项检查，${failed.length} 项失败。`);
process.exitCode = failed.length === 0 ? 0 : 1;

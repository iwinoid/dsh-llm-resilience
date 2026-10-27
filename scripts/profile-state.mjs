#!/usr/bin/env node
/**
 * profile 状态分析 + 孤儿 patch 修复（`scripts/smoke.mjs` 与自检共用）。
 *
 * 背景：本插件的行 `id: llm-resilience` 由 bundle 层 insert 提供；`settings` 服务
 * （DSH 的 configEditor）在设置页保存时会把用户改动写成 profile 用户层的一项
 * `- id: llm-resilience / config: {...}`。一旦把 bundle 从 `dsh.profile.bundles`
 * 移除，这一项就找不到目标行，Loader 每次启动都打印：
 *
 *   patch: entry "llm-resilience" not found
 *
 * 这是 DSH patch 模型的通用行为（任何"保存过配置的 bundle"取消选中都会如此），
 * 不是插件运行时代码能拦住的东西。所以本模块把这件事做成可检测、可修复：
 * 在"仅装了依赖、未启用 bundle"的状态下，发现孤儿项就给出并执行精确删除。
 *
 * 纯函数为主，便于单测。
 */
import { copyFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 本插件包名（也是 profile bundles 里的条目名）。 */
export const PLUGIN_NAME = 'dsh-llm-resilience';
/** 本插件的 Loader 行 id（也是 settings 命名空间）。 */
export const ROW_ID = 'llm-resilience';
/** profile 用户层 patch 文件名。 */
export const PATCH_FILENAME = 'cordis.patch.yml';

/**
 * 读取 JSON 文件，失败返回 undefined。
 * @param {string} path 文件路径。
 * @returns {any} 解析结果。
 */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * 定位 profile 目录。
 * @param {string} name profile 名。
 * @param {NodeJS.ProcessEnv} [env] 环境变量（优先读 DSH_HOME）。
 * @returns {string} profile 绝对路径。
 */
export function profileDir(name, env = process.env) {
  const home = env.DSH_HOME === undefined || env.DSH_HOME === '' ? join(homedir(), '.dsh') : env.DSH_HOME;
  return join(home, 'profiles', name);
}

/**
 * 读取一个 profile 的磁盘状态（只读）。
 * @param {string} dir profile 目录。
 * @returns {{
 *   dir: string,
 *   manifest: any,
 *   bundles: string[],
 *   dependency: string | undefined,
 *   patchPath: string,
 *   patchText: string | undefined,
 * }}
 */
export function readProfileState(dir) {
  const manifest = readJson(join(dir, 'package.json'));
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  const dependency = manifest?.dependencies?.[PLUGIN_NAME];
  const patchPath = join(dir, PATCH_FILENAME);
  let patchText;
  try {
    patchText = readFileSync(patchPath, 'utf8');
  } catch {
    patchText = undefined;
  }
  return { dir, manifest, bundles, dependency, patchPath, patchText };
}

/**
 * 找出用户层中所有"按 id 覆盖本插件行"的顶层块（不含 `insert:` 块）。
 *
 * 只匹配位于第 0 列的 `- id: llm-resilience`；`insert:` 里的子项缩进更深，
 * 不会命中，所以手动 insert 方式安装不会被误删。
 * @param {string} text patch 文件内容。
 * @param {string} [id] 目标行 id。
 * @returns {Array<{start: number, end: number, lines: string[]}>} 块的行区间（0 基、end 为开区间）。
 */
export function findRowBlocks(text, id = ROW_ID) {
  const lines = text.split('\n');
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^-\\s+id:\\s*['"]?${escape(id)}['"]?\\s*(?:#.*)?$`);
  const itemStart = /^-\s/;
  /** @type {Array<{start: number, end: number, lines: string[]}>} */
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!head.test(lines[index])) continue;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (itemStart.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    // 不吞掉块后面的空行：把它们留给下一段，避免拼出多余空白。
    let last = end;
    while (last > index + 1 && lines[last - 1].trim() === '') last -= 1;
    blocks.push({ start: index, end: last, lines: lines.slice(index, last) });
  }
  return blocks;
}

/**
 * 判断当前 profile 的插件状态，并列出会导致 dsh 启动告警的问题。
 * @param {ReturnType<typeof readProfileState>} state profile 状态。
 * @returns {{
 *   mode: 'enabled' | 'disabled',
 *   enabled: boolean,
 *   problems: Array<{code: string, message: string, fixable: boolean}>,
 *   notes: string[],
 *   rowBlocks: Array<{start: number, end: number, lines: string[]}>,
 * }}
 */
export function analyzeProfileState(state) {
  /** @type {Array<{code: string, message: string, fixable: boolean}>} */
  const problems = [];
  const notes = [];
  const enabled = state.bundles.includes(PLUGIN_NAME);
  const rowBlocks = state.patchText === undefined ? [] : findRowBlocks(state.patchText);

  if (typeof state.dependency !== 'string' || state.dependency === '') {
    problems.push({
      code: 'dependency-missing',
      message: `profile 依赖里没有 ${PLUGIN_NAME}：dsh 不会加载它（先 dsh plugin --profile <name> add ${PLUGIN_NAME}）`,
      fixable: false,
    });
  }

  if (enabled && state.patchText === undefined) {
    notes.push(`profile 没有 ${PATCH_FILENAME}（全部取默认值，正常）`);
  }

  if (enabled) {
    if (rowBlocks.length > 0) {
      notes.push(`用户层有 ${rowBlocks.length} 处本插件的配置覆盖（bundle 已启用，属正常）`);
    }
  } else if (rowBlocks.length > 0) {
    problems.push({
      code: 'orphan-patch',
      message:
        `bundle 未启用，但用户层仍有 ${rowBlocks.length} 处 "- id: ${ROW_ID}" 配置 → 每次启动都会打印 `
        + `patch: entry "${ROW_ID}" not found（加 --fix 可精确删除）`,
      fixable: true,
    });
  } else {
    notes.push('仅装了依赖、未启用 bundle：用户层无本插件配置，启动不会产生任何 patch 告警');
  }

  return { mode: enabled ? 'enabled' : 'disabled', enabled, problems, notes, rowBlocks };
}

/**
 * 生成删除孤儿块后的 patch 文本（不写盘）。
 * @param {string} text 原 patch 文本。
 * @param {Array<{start: number, end: number}>} blocks 待删除块。
 * @returns {string} 新文本。
 */
export function removeRowBlocks(text, blocks) {
  if (blocks.length === 0) return text;
  const lines = text.split('\n');
  const drop = new Set();
  for (const block of blocks) for (let index = block.start; index < block.end; index += 1) drop.add(index);
  const kept = lines.filter((_, index) => !drop.has(index));
  // 连续空行压成一行，避免删除后留下大段空白。
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * 备份并写回 patch 文件（临时文件 + rename，保持原权限）。
 * @param {string} path patch 文件路径。
 * @param {string} next 新内容。
 * @returns {string} 备份文件路径。
 */
export function writePatchWithBackup(path, next) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const backup = `${path}.bak-${stamp}`;
  copyFileSync(path, backup);
  const mode = statSync(path).mode & 0o777;
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, next, { mode });
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return backup;
}

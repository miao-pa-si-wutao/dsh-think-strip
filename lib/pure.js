/**
 * dsh-think-strip 的纯逻辑层。
 *
 * 这里的一切都不依赖 DSH 运行时（只用 node: 内置模块），因此可以脱离 Harness
 * 单独 `node -e "import('./lib/pure.js')"` 跑断言，也方便以后加单测。
 * 插件主体 lib/index.js 只负责把它接到 cordis 的会话事件与投影通道上。
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** 记录类型名，必须匹配 PLUGIN_RECORD_TYPE 语法，且与 projection.type 一致。 */
export const RECORD_TYPE = 'plugin:think-strip';

/** 工具结果被替换后必带的标记，用于幂等跳过与人工识别。 */
export const TOOL_MARKER = '…[工具输出已归档]…';

// ---------------------------------------------------------------------------
// 内容改写
// ---------------------------------------------------------------------------

/** 深冻结一个普通对象/数组树（已是冻结的节点直接跳过）。 */
export function deepFreeze(value) {
	if (value === null || typeof value !== 'object') return value;
	if (Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const key of Object.keys(value)) deepFreeze(value[key]);
	return value;
}

/** 拼接一条消息里所有 reasoning 块的原文。 */
export function reasoningText(content) {
	const parts = [];
	for (const block of content) {
		if (block?.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text);
	}
	return parts.join('\n');
}

/** 取思考首行做摘要：去 markdown 标记、压空白、截断。 */
export function firstLineSummary(text, maxChars) {
	const line =
		text
			.split('\n')
			.map((s) => s.trim())
			.find((s) => s.length > 0) ?? '';
	const clean = line
		.replace(/^[#>*\-\s]+/u, '')
		.replace(/\*\*|__|`/gu, '')
		.replace(/\s+/gu, ' ')
		.trim();
	if (clean.length === 0 || maxChars <= 0) return '';
	return clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
}

/**
 * 剥掉 content 里的 reasoning 块，可选在首个思考位置插一行摘要。
 * @returns 新 content 数组；没有 reasoning 时返回 null。
 */
export function stripReasoning(content, summaryText) {
	const kept = [];
	let firstIndex = -1;
	for (const block of content) {
		if (block?.type === 'reasoning') {
			if (firstIndex < 0) firstIndex = kept.length;
			continue;
		}
		kept.push(block);
	}
	if (firstIndex < 0) return null;
	if (summaryText !== null) kept.splice(firstIndex, 0, { type: 'text', text: summaryText });
	// 剥完一条不剩内容时给个占位，避免下游适配器拒收空 content。
	if (kept.length === 0) kept.push({ type: 'text', text: '[思考已归档]' });
	return kept;
}

/**
 * 把一条工具结果的纯文本压成「头 + 标记 + 尾」。
 * 只有全部是 text 块时才处理；含图片 / 文件 / 结构化块时返回 null（保守跳过）。
 * @returns 新 content 数组；不处理时返回 null。
 */
export function stripToolResult(content, replacement) {
	if (!Array.isArray(content) || content.length === 0) return null;
	if (!content.every((block) => block?.type === 'text')) return null;
	if (typeof replacement !== 'string' || replacement.length === 0) return null;
	// 已经是替换后的样子：幂等跳过。
	if (content.length === 1 && content[0].text === replacement) return null;
	if (content.length === 1 && content[0].text.includes(TOOL_MARKER)) return null;
	return [{ type: 'text', text: replacement }];
}

/** 把长文本压成「头 + 省略标记 + 说明 + 尾」。 */
export function headTailPreview(text, headChars, tailChars, notice) {
	const head = text.slice(0, headChars);
	const canTail = tailChars > 0 && text.length > headChars + tailChars;
	const tail = canTail ? text.slice(-tailChars) : '';
	const parts = [head, TOOL_MARKER, notice];
	if (tail !== '') parts.push(`…${tail}`);
	return parts.join('\n');
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/** 解析归档根目录。 */
export function resolveArchiveRoot(config) {
	if (typeof config.archiveDir === 'string' && config.archiveDir.trim() !== '') {
		return path.resolve(config.archiveDir.trim());
	}
	const home = process.env['DSH_HOME'] ?? path.join(homedir(), '.dsh');
	return path.join(home, 'think-archive');
}

/** 文件名安全的时间戳。 */
export function stampOf(time) {
	return new Date(time).toISOString().replace(/[:.]/gu, '-');
}

/**
 * 把值裁剪成「可无损写进 session 事件」的纯 JSON：丢掉 undefined 值的键。
 *
 * DSH 的 `snapshotJsonValue`（`@deepseek-ai/dsh-util-values`）只接受
 * boolean / string / 有限 number / plain object / plain array，碰到 undefined
 * 直接判定不可序列化，整个 `session.append` 会抛
 * `session event "…" carries non-JSON-serializable data` —— 投影就提交不上，
 * 归档写了也白写。所以像 `{ toolName: undefined }` 这样的字段必须先削掉。
 */
export function toJsonSafe(value) {
	return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// 会话级开关（磁盘上的 switches.json）
// ---------------------------------------------------------------------------

/**
 * 开关存储结构：
 * {
 *   "defaults": { "reasoning": true, "tools": false },     // 可省略 → 用 Config
 *   "sessions": { "session-xxx": { "reasoning": false } }   // 单会话覆盖
 * }
 */
export function emptySwitchStore() {
	return { defaults: {}, sessions: {} };
}

export async function loadSwitchStore(root) {
	const file = path.join(root, 'switches.json');
	try {
		const raw = await readFile(file, 'utf8');
		const parsed = JSON.parse(raw);
		const store = emptySwitchStore();
		if (parsed !== null && typeof parsed === 'object') {
			if (parsed.defaults !== null && typeof parsed.defaults === 'object') {
				store.defaults = { ...parsed.defaults };
			}
			if (parsed.sessions !== null && typeof parsed.sessions === 'object') {
				store.sessions = { ...parsed.sessions };
			}
		}
		return store;
	} catch {
		return emptySwitchStore();
	}
}

export async function saveSwitchStore(root, store) {
	const file = path.join(root, 'switches.json');
	await mkdir(root, { recursive: true });
	await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

/** 解析某个会话的最终开关：会话覆盖 > 全局默认 > Config。 */
export function resolveSwitch(store, config, sessionId) {
	if (config.enabled !== true) return { reasoning: false, tools: false };
	const entry = store.sessions?.[sessionId];
	const pick = (key, fallback) => {
		const override = entry?.[key];
		if (typeof override === 'boolean') return override;
		const globalDefault = store.defaults?.[key];
		if (typeof globalDefault === 'boolean') return globalDefault;
		return fallback === true;
	};
	return {
		reasoning: pick('reasoning', config.reasoningDefault),
		tools: pick('tools', config.toolsDefault),
	};
}

/**
 * 把一次开关变更应用到存储对象上（就地修改，返回是否变化）。
 * null 表示清除该会话的覆盖、回落到默认。
 */
export function applySwitchPatch(store, sessionId, patch) {
	const entry = { ...(store.sessions?.[sessionId] ?? {}) };
	for (const key of ['reasoning', 'tools']) {
		if (!(key in patch)) continue;
		const value = patch[key];
		if (value === null) delete entry[key];
		else if (typeof value === 'boolean') entry[key] = value;
		else return { ok: false, error: `${key} must be boolean or null` };
	}
	// 会话值全部清空时删掉这个键，避免 switches.json 长满空对象。
	if (Object.keys(entry).length === 0) delete store.sessions[sessionId];
	else store.sessions[sessionId] = entry;
	return { ok: true };
}

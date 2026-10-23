/**
 * lib/pure.js 的离线断言：不启动 Harness，直接 node --test 跑。
 *   node --test test/pure.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	TOOL_MARKER,
	applySwitchPatch,
	emptySwitchStore,
	firstLineSummary,
	headTailPreview,
	loadSwitchStore,
	reasoningText,
	resolveSwitch,
	saveSwitchStore,
	stampOf,
	stripReasoning,
	stripToolResult,
	toJsonSafe,
} from '../lib/pure.js';

test('toJsonSafe 丢掉 undefined 值的键（DSH append 的硬要求）', () => {
	const safe = toJsonSafe({
		targets: [{ seq: 1, kind: 'reasoning', summary: null }],
		indexed: [
			{ seq: 1, toolName: undefined, summary: 's' },
			{ seq: 2, toolName: 'ops_glob' },
		],
	});
	assert.deepEqual(safe, {
		targets: [{ seq: 1, kind: 'reasoning', summary: null }],
		indexed: [{ seq: 1, summary: 's' }, { seq: 2, toolName: 'ops_glob' }],
	});
	assert.equal(Object.hasOwn(safe.indexed[0], 'toolName'), false);
});

test('reasoningText 只拼 reasoning 块', () => {
	const content = [
		{ type: 'reasoning', text: 'a' },
		{ type: 'text', text: 'x' },
		{ type: 'reasoning', text: 'b' },
	];
	assert.equal(reasoningText(content), 'a\nb');
	assert.equal(reasoningText([{ type: 'text', text: 'x' }]), '');
});

test('firstLineSummary 去掉标记并截断', () => {
	assert.equal(firstLineSummary('## 用户要算 1+1。\n详情', 100), '用户要算 1+1。');
	assert.equal(firstLineSummary('**粗体** `code`', 100), '粗体 code');
	assert.equal(firstLineSummary('好好好', 2), '好好…');
	assert.equal(firstLineSummary('', 100), '');
	assert.equal(firstLineSummary('x', 0), '');
});

test('stripReasoning 插入摘要并保留顺序', () => {
	const content = [
		{ type: 'reasoning', text: 'first' },
		{ type: 'text', text: 'answer' },
	];
	const out = stripReasoning(content, '[思考摘要] first');
	assert.deepEqual(out, [
		{ type: 'text', text: '[思考摘要] first' },
		{ type: 'text', text: 'answer' },
	]);
	// 没有 reasoning 时返回 null（幂等跳过）
	assert.equal(stripReasoning([{ type: 'text', text: 'answer' }], 'x'), null);
	// 全剥空时补占位
	assert.deepEqual(stripReasoning([{ type: 'reasoning', text: 'only' }], null), [
		{ type: 'text', text: '[思考已归档]' },
	]);
});

test('stripToolResult 只处理纯文本 content 且幂等', () => {
	const replaced = [{ type: 'text', text: 'head\n' + TOOL_MARKER + '\nnotice' }];
	assert.deepEqual(stripToolResult([{ type: 'text', text: 'long output' }], replaced[0].text), replaced);
	// 已经是替换后的样子
	assert.equal(stripToolResult(replaced, replaced[0].text), null);
	// 含非文本块：保守跳过
	assert.equal(stripToolResult([{ type: 'text', text: 'a' }, { type: 'image' }], 'x'), null);
	assert.equal(stripToolResult([], 'x'), null);
	assert.equal(stripToolResult([{ type: 'text', text: 'a' }], ''), null);
});

test('headTailPreview 保留头尾并标出归档路径', () => {
	const text = 'A'.repeat(100) + 'B'.repeat(100) + 'C'.repeat(100);
	const out = headTailPreview(text, 10, 10, 'notice');
	assert.ok(out.startsWith('A'.repeat(10) + '\n'));
	assert.ok(out.includes(TOOL_MARKER));
	assert.ok(out.includes('notice'));
	assert.ok(out.endsWith('…' + 'C'.repeat(10)));
	// 原文不够长时不加尾部
	const short = headTailPreview('short', 100, 100, 'n');
	assert.equal(short, 'short\n' + TOOL_MARKER + '\nn');
});

test('resolveSwitch 优先级：会话覆盖 > 全局默认 > Config', () => {
	const config = { enabled: true, reasoningDefault: true, toolsDefault: true };
	assert.deepEqual(resolveSwitch(emptySwitchStore(), config, 's1'), { reasoning: true, tools: true });

	const store = emptySwitchStore();
	store.defaults = { reasoning: false, tools: true };
	assert.deepEqual(resolveSwitch(store, config, 's1'), { reasoning: false, tools: true });

	store.sessions = { s1: { reasoning: true, tools: false } };
	assert.deepEqual(resolveSwitch(store, config, 's1'), { reasoning: true, tools: false });
	// 别的会话仍走 defaults
	assert.deepEqual(resolveSwitch(store, config, 's2'), { reasoning: false, tools: true });

	// 总开关关掉时两个都是 false
	assert.deepEqual(resolveSwitch(store, { ...config, enabled: false }, 's1'), {
		reasoning: false,
		tools: false,
	});
});

test('applySwitchPatch 写入 / 清除覆盖', () => {
	const store = emptySwitchStore();
	assert.equal(applySwitchPatch(store, 's1', { reasoning: false }).ok, true);
	assert.deepEqual(store.sessions.s1, { reasoning: false });

	assert.equal(applySwitchPatch(store, 's1', { tools: true }).ok, true);
	assert.deepEqual(store.sessions.s1, { reasoning: false, tools: true });

	// null 清除该键；清空后整条会话记录消失
	assert.equal(applySwitchPatch(store, 's1', { reasoning: null }).ok, true);
	assert.deepEqual(store.sessions.s1, { tools: true });
	assert.equal(applySwitchPatch(store, 's1', { tools: null }).ok, true);
	assert.equal(store.sessions.s1, undefined);

	// 非法值被拒绝且不改动
	assert.equal(applySwitchPatch(store, 's1', { reasoning: 'yes' }).ok, false);
	assert.equal(store.sessions.s1, undefined);
});

test('switches.json 落盘往返 + 坏文件回退为空存储', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'think-strip-test-'));
	try {
		const store = emptySwitchStore();
		store.defaults = { reasoning: false };
		store.sessions = { abc: { tools: false } };
		await saveSwitchStore(dir, store);

		const loaded = await loadSwitchStore(dir);
		assert.deepEqual(loaded.defaults, { reasoning: false });
		assert.deepEqual(loaded.sessions, { abc: { tools: false } });

		// 目录里根本没有 switches.json 时也返回空存储
		const empty = await loadSwitchStore(path.join(dir, 'nowhere'));
		assert.deepEqual(empty, emptySwitchStore());
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('stampOf 生成文件名安全的时间戳', () => {
	const stamp = stampOf(1760950000000);
	assert.equal(stamp.includes(':'), false);
	assert.equal(stamp.includes('.'), false);
	assert.match(stamp, /^\d{4}-\d{2}-\d{2}T/);
});

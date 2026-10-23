/**
 * 端到端模拟：把真实会话日志里的每条 tool/result 与 assistant/message
 * 过一遍 pure.js 的剥离函数，核对
 *   1. 输出结构合法（仍是 ContentBlock[]，块都有 type）
 *   2. 省掉多少字符
 *   3. 幂等（对已剥离的内容再跑一次不产生变化）
 *
 * 不需要 DSH 运行时：node test/simulate.mjs <jsonl>
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import {
	TOOL_MARKER,
	firstLineSummary,
	headTailPreview,
	reasoningText,
	stripReasoning,
	stripToolResult,
} from '../lib/pure.js';

const file = process.argv[2];
const HEAD = 1200;
const TAIL = 400;
const MIN = 4000;

let toolBefore = 0;
let toolAfter = 0;
let toolTouched = 0;
let reasoningBefore = 0;
let reasoningAfter = 0;
let reasoningTouched = 0;
const problems = [];

function checkBlocks(where, content) {
	if (!Array.isArray(content)) {
		problems.push(`${where}: content is not an array`);
		return;
	}
	for (const block of content) {
		if (block === null || typeof block !== 'object' || typeof block.type !== 'string') {
			problems.push(`${where}: invalid block`);
			return;
		}
		if (block.type === 'text' && typeof block.text !== 'string') {
			problems.push(`${where}: text block without text`);
			return;
		}
	}
}

await new Promise((resolve, reject) => {
	const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
	rl.on('line', (line) => {
		if (!line.trim()) return;
		let ev;
		try {
			ev = JSON.parse(line);
		} catch {
			return;
		}
		const content = ev.data?.message?.content;
		if (!Array.isArray(content)) return;

		if (ev.type === 'tool/result') {
			const text = content.map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n');
			const allText = content.every((b) => b?.type === 'text');
			if (!allText || text.length < MIN || text.includes(TOOL_MARKER)) return;
			const replacement = headTailPreview(
				text,
				HEAD,
				TAIL,
				`（原文 ${text.length} 字符已归档：Z:\\fake\\path.json；可用 read 或 grep 读取）`,
			);
			const next = stripToolResult(content, replacement);
			if (next === null) {
				problems.push(`seq ${ev.seq}: stripToolResult returned null on a strip-able result`);
				return;
			}
			checkBlocks(`tool seq ${ev.seq}`, next);
			if (stripToolResult(next, replacement) !== null) {
				problems.push(`seq ${ev.seq}: tool strip is not idempotent`);
			}
			toolBefore += text.length;
			toolAfter += next[0].text.length;
			toolTouched += 1;
			return;
		}

		if (ev.type === 'assistant/message') {
			const text = reasoningText(content);
			if (text.length === 0) return;
			const summary = firstLineSummary(text, 100);
			const summaryText = `[思考摘要] ${summary}`;
			const next = stripReasoning(content, summaryText);
			if (next === null) {
				problems.push(`seq ${ev.seq}: stripReasoning returned null with reasoning present`);
				return;
			}
			checkBlocks(`assistant seq ${ev.seq}`, next);
			if (stripReasoning(next, summaryText) !== null) {
				problems.push(`seq ${ev.seq}: reasoning strip is not idempotent`);
			}
			reasoningBefore += text.length;
			reasoningAfter += next
				.filter((b) => b?.type === 'text')
				.reduce((sum, b) => sum + b.text.length, 0);
			reasoningTouched += 1;
		}
	});
	rl.on('close', resolve);
	rl.on('error', reject);
});

console.log(
	JSON.stringify(
		{
			tool: {
				touched: toolTouched,
				before: toolBefore,
				after: toolAfter,
				saved: toolBefore - toolAfter,
			},
			reasoning: {
				touched: reasoningTouched,
				before: reasoningBefore,
				after: reasoningAfter,
				saved: reasoningBefore - reasoningAfter,
			},
			problems: problems.slice(0, 10),
			problemCount: problems.length,
		},
		null,
		2,
	),
);
process.exitCode = problems.length === 0 ? 0 : 1;

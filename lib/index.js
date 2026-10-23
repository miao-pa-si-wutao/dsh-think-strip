/**
 * dsh-think-strip  —— 历史思考 / 工具输出隔离（带会话级开关）
 *
 * 两个能力，两个独立开关：
 *   1. reasoning  把历史 assistant 消息里的思考（reasoning）块从模型上下文中剥离；
 *   2. tools      把历史里过长的工具结果（tool/result 纯文本）压成「头尾预览 + 归档路径」。
 * 两者都把原文按时间戳归档到磁盘并写索引，每处只留一行摘要 / 预览。
 *
 * 实现通道（与 v0.1 一致，保持向后兼容）：
 *   1. `appendPluginRecord()` 写一条 `plugin:think-strip` 记录（ignorable，
 *      不动 surface nodes）；targets 现在带 `kind`（'reasoning' | 'tool'），
 *      旧记录没有 kind，按 'reasoning' 解释，因此老会话照常投影。
 *   2. `ctx.sessions.registerMessageProjection()` 注册同类型名的投影，
 *      fold 时把记录点名的 seq 换成冻结副本。
 *   3. 每一轮的开关状态存在 `<archiveDir>/switches.json`（按 sessionId 覆盖，
 *      缺省回落到 Config）。开关不是会话日志的一部分：它只决定「这一轮要不要
 *      提交新的剥离记录」，已经提交的记录永远继续生效。
 *
 * 为什么不改写日志：append-only 日志是唯一真相源，fork/resume/replay 都从它
 * 派生。投影只影响「模型看到什么」，日志原文永远完整可查。
 */

import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';
import { mkdir, appendFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import {
	RECORD_TYPE,
	TOOL_MARKER,
	applySwitchPatch,
	deepFreeze,
	emptySwitchStore,
	firstLineSummary,
	headTailPreview,
	loadSwitchStore,
	reasoningText,
	resolveArchiveRoot,
	resolveSwitch,
	saveSwitchStore,
	stampOf,
	stripReasoning,
	stripToolResult,
	toJsonSafe,
} from './pure.js';

export { TOOL_MARKER, RECORD_TYPE };

export const name = 'dsh-think-strip';

/** 只依赖 sessions；缺了它插件没有意义。 */
export const inject = ['sessions'];

export const Config = z.object({
	enabled: z.boolean().default(true)
		.description('总开关；关掉后两个功能都不再处理新回合，已提交的记录仍然生效'),
	/** 归档根目录；留空表示 `<dshHome>/think-archive`。 */
	archiveDir: z.string().default('')
		.description('归档根目录；留空表示 <DSH_HOME>/think-archive'),
	archive: z.boolean().default(true)
		.description('是否把原文写盘；关掉则只剥离不留档'),
	summaryMode: z.union([z.const('first-line'), z.const('none')]).default('first-line')
		.description('思考摘要模式：first-line 取思考首行；none 只留 [思考已归档] 占位'),
	summaryMaxChars: z.number().min(0).max(2000).default(100)
		.description('思考摘要最大字符数'),
	minReasoningChars: z.number().min(0).default(0)
		.description('思考字符数低于此值时不剥离（短思考留着更省事）'),
	keepSummary: z.boolean().default(true)
		.description('是否在剥离位置插入一行摘要正文；关掉则完全不留痕'),
	// ── 会话级开关的默认值（新会话 / 未单独设置过的会话用这一档）──
	reasoningDefault: z.boolean().default(true)
		.description('没单独设置过的会话，默认是否隔离思考内容'),
	toolsDefault: z.boolean().default(true)
		.description('没单独设置过的会话，默认是否隔离工具输出'),
	// ── 工具输出隔离的阈值 ──
	toolStripChars: z.number().min(0).default(4000)
		.description('工具结果的纯文本超过此字符数才压缩；0 表示全部压缩'),
	toolHeadChars: z.number().min(0).default(1200)
		.description('压缩后保留的头部字符数'),
	toolTailChars: z.number().min(0).default(400)
		.description('压缩后保留的尾部字符数'),
	trace: z.boolean().default(true)
		.description('每个回合往 <archiveDir>/plugin.log 追加一行工作记录（开关状态 / 事件数 / 命中数）'),
});

// ---------------------------------------------------------------------------
// 投影定义
// ---------------------------------------------------------------------------

/**
 * 把记录点名的消息换成剥离后的冻结副本。
 * targets 每项：{ seq, kind?: 'reasoning'|'tool', summary?, replacement? }
 * 旧记录只有 { seq, summary }，缺省视为 reasoning。
 *
 * 与 image/offload 一样，必须叠加在 `context.messages` 之上，
 * 不能覆盖别的投影。目标 seq 已不在 surface 上（被压缩遮蔽）时静默跳过。
 */
export const thinkStripProjection = {
	type: RECORD_TYPE,
	project(event, context) {
		const targets = event.data?.targets;
		if (!Array.isArray(targets) || targets.length === 0) return new Map();

		const messages = new Map();
		for (const target of targets) {
			const seq = target?.seq;
			if (typeof seq !== 'number') continue;

			let message = context.messages.get(seq);
			if (message === undefined) {
				const source = context.events[seq - context.baseSeq];
				if (source === undefined) continue;
				message = source.data?.message;
				if (message === undefined) continue;
			}

			const content = message.content ?? [];
			const kind = target.kind === 'tool' ? 'tool' : 'reasoning';
			const next =
				kind === 'tool'
					? stripToolResult(content, target.replacement)
					: stripReasoning(content, typeof target.summary === 'string' ? target.summary : null);
			if (next === null) continue; // 已经处理过，别的投影或上一轮已经做过

			messages.set(seq, deepFreeze({ ...message, content: next }));
		}
		return messages;
	},
};

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
	const root = resolveArchiveRoot(config);

	ctx.sessions.registerMessageProjection(thinkStripProjection);

	// 开关状态：进程内缓存 + 磁盘。写入方（HTTP 路由）改缓存后立刻落盘；
	// 读取方（每轮 turn-stopping）直接读缓存，避免每轮一次 IO。
	let switchStore = emptySwitchStore();
	const switchReady = loadSwitchStore(root)
		.then((store) => {
			switchStore = store;
		})
		.catch((error) => {
			console.warn(`[dsh-think-strip] switches load failed: ${error?.message ?? error}`);
		});

	// 启动标记：用来区分「apply 没跑」和「跑了但 turn-stopping 没触发」。
	void (async () => {
		try {
			await mkdir(root, { recursive: true });
			await appendFile(
				path.join(root, 'plugin.log'),
				`${new Date().toISOString()} apply root=${root} enabled=${String(config.enabled)} reasoningDefault=${String(config.reasoningDefault)} toolsDefault=${String(config.toolsDefault)}\n`,
				'utf8',
			);
		} catch (error) {
			console.warn(`[dsh-think-strip] startup marker failed: ${error?.message ?? error}`);
		}
	})();

	/** 归档一条原文，返回索引条目（失败返回 undefined）。 */
	async function archive(record) {
		if (config.archive !== true) return undefined;
		const dir = path.join(root, record.sessionId);
		const suffix =
			record.kind === 'tool' ? `tool-${record.seq}` : `t${record.turn}-s${record.step}-q${record.seq}`;
		const file = `${stampOf(record.time)}-${suffix}.json`;
		const full = path.join(dir, file);
		const entry = {
			time: record.time,
			sessionId: record.sessionId,
			kind: record.kind,
			turn: record.turn,
			step: record.step,
			seq: record.seq,
			...(record.toolName === undefined ? {} : { toolName: record.toolName }),
			chars: record.chars,
			summary: record.summary,
			file: path.relative(root, full).split(path.sep).join('/'),
		};
		try {
			await mkdir(dir, { recursive: true });
			// 同一条原文可能被重复扫描到（上一次投影提交失败、或用户把开关关掉再打开）。
			// 文件已存在就不再写盘、也不再往 index.jsonl 追加重复行，但照样返回 entry，
			// 让调用方能够提交投影。
			try {
				await access(full);
				return entry;
			} catch {
				/* 文件不存在，往下走写入 */
			}
			await writeFile(full, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
			await appendFile(path.join(root, 'index.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
			return entry;
		} catch (error) {
			console.warn(`[dsh-think-strip] archive failed for seq ${record.seq}: ${error?.message ?? error}`);
			return undefined;
		}
	}

	// agent/turn-stopping 是 serial 且被 await：监听器抛错会向上传播、阻塞回合关闭。
	// 所以整个主体包在 try/catch 里，任何异常都只降级为一条警告。
	ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
		if (config.enabled !== true) return;
		try {
			await switchReady;
			const stats = await stripTurn(ctx, agent, turn);
			await trace(`turn=${turn} ${stats}`);
		} catch (error) {
			await trace(`turn=${turn} FAILED ${error?.message ?? error}`);
			console.warn(`[dsh-think-strip] turn-stopping failed: ${error?.message ?? error}`);
		}
	});

	/** 每回合一行工作记录，用来判断 turn-stopping 到底跑了什么。 */
	async function trace(line) {
		if (config.trace !== true) return;
		try {
			await appendFile(path.join(root, 'plugin.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
		} catch {
			/* 诊断日志失败不影响主流程 */
		}
	}

	async function stripTurn(ctx, agent, turn) {
		const session = ctx.sessions.get(agent.id);
		if (session === undefined) return `agent=${agent.id} session=MISSING`;

		const switching = resolveSwitch(switchStore, config, session.id);
		const events = session.snapshotEvents();
		const surfaceCount = session.surface?.nodes?.length ?? 0;
		const head = `sid=${session.id} sw=r${switching.reasoning ? 1 : 0}t${switching.tools ? 1 : 0} ev=${events.length} sf=${surfaceCount}`;
		if (!switching.reasoning && !switching.tools) return `${head} both-off`;

		const targets = [];
		const pending = [];
		// 只有当前 surface 节点上的消息才进模型上下文。被压缩（compaction）用
		// surfaceOp: replace 遮蔽掉的旧消息仍在日志里，但对它们做投影毫无意义，
		// 还会白写一堆归档文件 —— 所以先取一份节点集合作白名单。
		const surfaceNodes = new Set(session.surface?.nodes ?? []);

		// 工具名：从 tool/call 事件按 callId 建表，供归档时记录「哪个工具的输出」。
		const toolNames = new Map();
		for (const event of events) {
			if (event.type === 'tool/call') toolNames.set(event.data?.callId, event.data?.name);
		}

		// 回扫全部历史而不是只扫本轮：插件启用前 / 开关打开前的回合也积压着原文，
		// 只处理当轮会让它们永远留在上下文里。已处理过的消息经 deriveEventMessage
		// 读出来时已经不含原文，天然幂等跳过。
		for (let i = events.length - 1; i >= 0; i -= 1) {
			const event = events[i];
			if (surfaceNodes.size > 0 && !surfaceNodes.has(event.seq)) continue;
			const eventTurn = event.data?.turn;
			if (typeof eventTurn !== 'number') continue;

			if (event.type === 'assistant/message' && switching.reasoning) {
				const live = session.deriveEventMessage(event);
				if (live === undefined || live === null) continue;
				const content = live.content ?? [];
				const text = reasoningText(content);
				if (text.length === 0) continue;
				if (text.length < config.minReasoningChars) continue;

				const summary =
					config.summaryMode === 'first-line' ? firstLineSummary(text, config.summaryMaxChars) : '';
				const summaryText =
					config.keepSummary === true
						? summary !== ''
							? `[思考摘要] ${summary}`
							: '[思考已归档]'
						: null;

				targets.push({ seq: event.seq, kind: 'reasoning', summary: summaryText });
				pending.push({
					kind: 'reasoning',
					time: event.time,
					sessionId: session.id,
					turn: eventTurn,
					step: event.data.step,
					seq: event.seq,
					model: event.data.message?.source?.model,
					summary,
					chars: text.length,
					reasoning: text,
					text: content
						.filter((block) => block?.type === 'text')
						.map((block) => block.text)
						.join('\n'),
				});
				continue;
			}

			if (event.type === 'tool/result' && switching.tools) {
				const live = session.deriveEventMessage(event);
				if (live === undefined || live === null) continue;
				const content = live.content ?? [];
				if (!Array.isArray(content) || content.length === 0) continue;
				// 含非文本块（图片 / 附件 / 结构化）时不碰，保守优先。
				if (!content.every((block) => block?.type === 'text')) continue;
				const text = content.map((block) => block.text ?? '').join('\n');
				if (text.length === 0) continue;
				if (text.includes(TOOL_MARKER)) continue; // 已压缩过
				if (config.toolStripChars > 0 && text.length < config.toolStripChars) continue;

				const toolName = toolNames.get(event.data?.message?.toolCallId);
				targets.push({ seq: event.seq, kind: 'tool' });
				pending.push({
					kind: 'tool',
					time: event.time,
					sessionId: session.id,
					turn: eventTurn,
					step: event.data.step,
					seq: event.seq,
					toolName,
					chars: text.length,
					summary: `${toolName ?? '工具'} 输出 ${text.length} 字符`,
					text,
				});
			}
		}

		if (targets.length === 0) return `${head} targets=0`;

		// 先归档再提交投影：即使投影提交失败，原文也已经落盘。
		// 并行写入：积压量大时（首次启用可能几百条）串行 await 会明显拖慢回合关闭。
		const indexed = [];
		const archived = await Promise.all(pending.map((record) => archive(record)));
		for (const entry of archived) {
			if (entry !== undefined) indexed.push(entry);
		}

		// 只投影真正归档成功的 seq。归档失败却照样投影，等于把原文永久丢掉。
		const archivedBySeq = new Map(indexed.map((entry) => [entry.seq, entry]));
		const textBySeq = new Map(pending.map((record) => [record.seq, record.text]));
		const safeTargets = [];
		for (const target of targets) {
			const entry = archivedBySeq.get(target.seq);
			if (entry === undefined) continue;
			if (target.kind === 'tool') {
				const notice = `（原文 ${entry.chars ?? 0} 字符已归档：${path.join(root, entry.file)}；可用 read 或 grep 读取）`;
				safeTargets.push({
					...target,
					replacement: headTailPreview(
						textBySeq.get(target.seq) ?? '',
						config.toolHeadChars,
						config.toolTailChars,
						notice,
					),
				});
			} else {
				safeTargets.push(target);
			}
		}
		const dropped = targets.length - safeTargets.length;
		if (dropped > 0) {
			console.warn(`[dsh-think-strip] ${dropped} message(s) kept in context because archiving failed`);
		}
		if (safeTargets.length === 0) return `${head} targets=${targets.length} archived=0`;

		let committed = false;
		try {
			// toJsonSafe 是兜底：索引条目里的可选字段（toolName 等）可能是
			// undefined，而 DSH 的 append 会因此整条拒绝，投影就提交不上。
			appendPluginRecord(session, RECORD_TYPE, toJsonSafe({ targets: safeTargets, indexed }));
			committed = true;
		} catch (error) {
			await trace(`commit FAILED ${error?.message ?? error}`);
			console.warn(`[dsh-think-strip] failed to commit strip record: ${error?.message ?? error}`);
		}
		return `${head} targets=${safeTargets.length} ${committed ? 'committed' : 'commit-failed'}`;
	}

	// ── 会话级开关的 HTTP 端点（聊天输入框左侧的两个按钮用） ──────────────
	// webServer 要 INJECT 而不是 lookup：cordis 只在服务真的存在后才触发 inject
	// 回调，能消掉启动时序竞态（computer-user-vision 踩过这个坑并写进了注释）。
	try {
		ctx.inject(['webServer'], (sctx) => {
			let webServer;
			try {
				webServer = sctx.webServer ?? ctx.get('webServer');
			} catch (error) {
				console.warn(`[dsh-think-strip] webServer lookup threw: ${error?.message ?? error}`);
			}
			if (!webServer || typeof webServer.register !== 'function') {
				console.warn('[dsh-think-strip] webServer unavailable; switch route not registered');
				return;
			}

			const writeJson = (res, status, payload) => {
				res.writeHead(status, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store',
				});
				res.end(JSON.stringify(payload));
			};
			const isLoopback = (req) => {
				const address = req.socket?.remoteAddress ?? '';
				return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
			};
			const snapshot = (sessionId) => {
				const resolved = resolveSwitch(switchStore, config, sessionId);
				return {
					sessionId,
					enabled: config.enabled === true,
					available: config.enabled === true,
					reasoning: resolved.reasoning,
					tools: resolved.tools,
					overrides: switchStore.sessions?.[sessionId] ?? null,
				};
			};

			try {
				sctx.effect(
					() =>
						webServer.register({
							kind: 'exact',
							path: '/think-strip/state',
							handler: async (req, res) => {
								if (!isLoopback(req)) {
									writeJson(res, 403, { error: 'loopback only' });
									return;
								}
								const url = new URL(req.url ?? '/', 'http://localhost');
								const sessionId = url.searchParams.get('sessionId') ?? '';
								if (sessionId === '') {
									writeJson(res, 400, { error: 'sessionId required' });
									return;
								}

								if (req.method === 'GET') {
									writeJson(res, 200, snapshot(sessionId));
									return;
								}
								if (req.method !== 'POST') {
									writeJson(res, 405, { error: 'method not allowed' });
									return;
								}

								let raw = '';
								await new Promise((resolve) => {
									req.on('data', (chunk) => {
										raw += chunk;
										if (raw.length > 8192) req.destroy();
									});
									req.on('end', resolve);
								});

								let patch;
								try {
									patch = JSON.parse(raw || '{}');
								} catch {
									writeJson(res, 400, { error: 'bad json' });
									return;
								}

								await switchReady;
								const applied = applySwitchPatch(switchStore, sessionId, patch);
								if (!applied.ok) {
									writeJson(res, 400, { error: applied.error });
									return;
								}

								try {
									await saveSwitchStore(root, switchStore);
								} catch (error) {
									writeJson(res, 500, { error: String(error?.message ?? error) });
									return;
								}
								writeJson(res, 200, snapshot(sessionId));
							},
						}),
					'dsh-think-strip: switch state route',
				);
			} catch (error) {
				console.warn(`[dsh-think-strip] switch route registration threw: ${error?.message ?? error}`);
			}
		});
	} catch (error) {
		console.warn(`[dsh-think-strip] webServer inject threw: ${error?.message ?? error}`);
	}
}

/**
 * dsh-think-strip —— Client 半部
 *
 * 在聊天输入框左侧（conversation.input.left）放两个会话级开关：
 *   思考：本会话是否把历史思考内容从模型上下文里剥离；
 *   工具：本会话是否把过长的工具输出压成预览并剥离。
 *
 * 状态来自 Host 的 /think-strip/state 端点，按当前 sessionId 读写。
 * 纯 view 交互，不需要给 Agent 暴露工具。
 *
 * 契约要点（照 computer-user-vision 的写法）：
 *   - `conversation.input.left` 是 scope=session 的 list 槽，kit 里自带
 *     `sessionId`；entry 声明 `locale` 后 kit 还会带 `t`。这里两者都用。
 *   - 手写 ModuleLoader bundle，无构建步骤。
 */

window.__ModuleLoader__.load({
  id: 'dsh-think-strip',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-think-strip';
    const API = '/think-strip/state';

    const ZH = {
      reasoning: '思考',
      tools: '工具',
      reasoningHint: '把本会话历史里的思考内容从模型上下文中剥离（原文归档到磁盘）',
      toolsHint: '把本会话里过长的工具输出压成预览（原文归档到磁盘）',
      unavailable: '总开关已关闭',
    };
    const EN = {
      reasoning: 'Think',
      tools: 'Tools',
      reasoningHint: 'Strip reasoning blocks from this session context (originals are archived to disk)',
      toolsHint: 'Compress oversized tool results in this session to a preview (originals archived)',
      unavailable: 'master switch off',
    };

    const CSS = [
      '.__ts_row{display:inline-flex;align-items:center;gap:6px}',
      '.__ts_pill{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;' +
        'border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:transparent;' +
        'font:inherit;font-size:12px;line-height:1;cursor:pointer;color:var(--dsw-alias-label-secondary);' +
        'transition:background 160ms ease,color 160ms ease,border-color 160ms ease}',
      '.__ts_pill:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.__ts_pill:disabled{opacity:.45;cursor:default}',
      '.__ts_on{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.__ts_track{position:relative;width:24px;height:14px;border-radius:7px;' +
        'background:var(--dsw-alias-border-l3);transition:background 160ms ease}',
      '.__ts_on .__ts_track{background:var(--dsw-alias-state-success-primary)}',
      '.__ts_knob{position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;' +
        'background:#fff;transition:transform 160ms ease}',
      '.__ts_on .__ts_knob{transform:translateX(10px)}',
      '.__ts_err{font-size:11px;opacity:.6}',
    ].join('');

    function StyleTag() {
      return h('style', { 'data-plugin': NS }, CSS);
    }

    function Pill(props) {
      const { on, label, title, disabled, onClick } = props;
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          'aria-label': label,
          className: on ? '__ts_pill __ts_on' : '__ts_pill',
          title,
          disabled: Boolean(disabled),
          onClick,
        },
        h('span', { className: '__ts_track' }, h('span', { className: '__ts_knob' })),
        h('span', null, label),
      );
    }

    /** 组件工厂：把 locale 绑定注入闭包，避免每次渲染重新 bind。 */
    function makeSwitches(t) {
      return function Switches(props) {
        const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : '';
        const [state, setState] = React.useState(null);
        const [error, setError] = React.useState(null);
        const [busy, setBusy] = React.useState(false);

        const read = React.useCallback(
          function () {
            if (sessionId === '') return;
            fetch(API + '?sessionId=' + encodeURIComponent(sessionId), {
              headers: { accept: 'application/json' },
            })
              .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
              })
              .then(function (json) {
                setState(json);
                setError(null);
              })
              .catch(function (cause) {
                setError(String(cause && cause.message ? cause.message : cause));
              });
          },
          [sessionId],
        );

        // 别的标签页 / 别处改过开关时这里要跟上，所以轮询而不是只读一次。
        React.useEffect(
          function () {
            read();
            const timer = setInterval(read, 5000);
            return function () {
              clearInterval(timer);
            };
          },
          [read],
        );

        function toggle(key) {
          if (busy || sessionId === '' || state === null || state.available !== true) return;
          const next = {};
          next[key] = !(state[key] === true);
          setBusy(true);
          fetch(API + '?sessionId=' + encodeURIComponent(sessionId), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(next),
          })
            .then(function (response) {
              if (!response.ok) throw new Error('HTTP ' + response.status);
              return response.json();
            })
            .then(function (json) {
              setState(json);
              setError(null);
              setBusy(false);
            })
            .catch(function (cause) {
              setError(String(cause && cause.message ? cause.message : cause));
              setBusy(false);
            });
        }

        if (sessionId === '') return h(StyleTag, null);

        const available = Boolean(state && state.available === true);
        const reasoning = Boolean(state && state.reasoning === true);
        const tools = Boolean(state && state.tools === true);
        const disabled = busy || !available;

        return h(
          'span',
          { className: '__ts_row' },
          h(StyleTag, null),
          h(Pill, {
            on: reasoning,
            label: t('reasoning'),
            title: available ? t('reasoningHint') : t('unavailable'),
            disabled,
            onClick: function () {
              toggle('reasoning');
            },
          }),
          h(Pill, {
            on: tools,
            label: t('tools'),
            title: available ? t('toolsHint') : t('unavailable'),
            disabled,
            onClick: function () {
              toggle('tools');
            },
          }),
          error !== null ? h('span', { className: '__ts_err', title: error }, '⚠') : null,
        );
      };
    }

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: ZH, en: EN });
      }, 'dsh-think-strip: dictionaries');

      const t = ctx.locale.bind(NS);
      const Switches = makeSwitches(t);

      ctx.slots.inject('conversation.input.left', function () {
        return ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'think-strip-switches',
            order: 45,
            locale: NS,
          },
          Switches,
        );
      });
    }

    return { inject: ['slots', 'locale'], apply: apply };
  },
});

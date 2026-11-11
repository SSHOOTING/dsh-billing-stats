window.__ModuleLoader__.load({
  id: 'dsh-billing-attribution',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const name = 'billing-attribution-client'
    const inject = ['slots']

    function formatMoney(micros, currency) {
      const amount = Math.max(0, Number.isFinite(micros) ? micros : 0) / 1e6
      const digits = amount >= 1 ? 2 : amount >= 0.01 ? 4 : 6
      return `${currency === 'CNY' ? '¥' : '$'}${amount.toFixed(digits)}`
    }

    function componentRows(totals, currency) {
      const labels = {
        uncachedInput: '未缓存输入',
        uncachedInputTokens: '未缓存输入',
        cacheRead: '缓存读取',
        cacheReadTokens: '缓存读取',
        cacheWrite: '缓存写入',
        cacheWriteTokens: '缓存写入',
        output: '输出',
        outputTokens: '输出',
        searchFee: '搜索费',
        search: '搜索',
        unknown: '未知',
      }
      return Object.entries(totals || {})
        .filter(([, value]) => value.billedMicros > 0 || value.listMicros > 0)
        .sort((left, right) => right[1].billedMicros - left[1].billedMicros)
        .map(([key, value]) => `${labels[key] || key} ${formatMoney(value.billedMicros, currency)}`)
    }

    function BillingDock(props) {
      const projection = props.useProjection('billing')
      const cardStyle = {
        boxSizing: 'border-box',
        width: 'calc(100% - 2 * var(--dsh-composer-side-clearance, 24px) - 4 * var(--dsh-composer-dock-inset, 8px))',
        maxWidth: 'calc(var(--dsh-composer-card-max-width, 760px) - 4 * var(--dsh-composer-dock-inset, 8px))',
        margin: '0 auto',
        padding: '9px 12px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))',
        borderRadius: '12px',
        background: 'var(--dsw-specific-tip, rgba(127,127,127,.06))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '12px',
        lineHeight: '19px',
      }
      if (projection === undefined) {
        return h('div', { style: cardStyle, 'data-billing-attribution': true },
          h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #777)' } }, '计费归因：等待会话投影…'),
        )
      }
      const currency = projection.currency || 'CNY'
      const phaseLabel = projection.turnPhase === 'active'
        ? '本轮进行中'
        : projection.turnPhase === 'ended'
          ? '上一轮已结束'
          : '等待请求'
      const parts = componentRows(projection.turnComponentTotals, currency)
      const last = projection.lastRequest
      const color = projection.unknown
        ? 'var(--dsw-alias-state-warning-primary, #b26a00)'
        : 'var(--dsw-alias-state-success-primary, #238636)'
      const rows = [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
        },
        h('span', { key: 'dot', style: { width: '7px', height: '7px', borderRadius: '999px', background: color, flex: 'none' } }),
        h('strong', { key: 'title', style: { fontSize: '13px', fontWeight: 650 } }, '计费归因'),
        h('span', { key: 'phase', style: { color: 'var(--dsw-alias-label-secondary, inherit)' } }, phaseLabel),
        h('span', { key: 'sep1', style: { color: 'var(--dsw-alias-label-tertiary, #777)' } }, '·'),
        h('span', { key: 'spent' }, `账单口径 ${formatMoney(projection.turnBilledMicros, currency)}`),
        h('span', { key: 'list' }, `公开价 ${formatMoney(projection.turnListMicros, currency)}`),
        h('span', { key: 'requests' }, `${projection.turnRequestCount} 次请求`),
        h('span', { key: 'profile', style: { marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary, #777)' } },
          `${projection.profileLabel || projection.profileId || '价格档案未知'}${projection.pricingVerified ? '' : ' · 待验证'}`),
        ),
        parts.length > 0
          ? h('div', { key: 'components', style: { marginTop: '4px', color: 'var(--dsw-alias-label-secondary, inherit)' } }, parts.join(' · '))
          : null,
        last
          ? h('div', { key: 'last', style: { marginTop: '4px', color: 'var(--dsw-alias-label-tertiary, #777)' } },
            `最近一次：${last.provider}/${last.model} · ${formatMoney(last.billedMicros, currency)}`
            + ` · 输入 ${last.buckets.uncachedInputTokens} / 缓存读 ${last.buckets.cacheReadTokens} / 输出 ${last.buckets.outputTokens}`,
          )
          : null,
        projection.unknown
          ? h('div', { key: 'unknown', role: 'status', style: { marginTop: '4px', color } },
            '存在未知分项：缺 usage 或缺价格，未按 0 计算。输入 /cost explain 查看最近请求。')
          : null,
        h('div', { key: 'totals', style: { marginTop: '4px', color: 'var(--dsw-alias-label-tertiary, #777)' } },
          `会话累计：${formatMoney(projection.billedSpentMicros, currency)} · 搜索请求 ${projection.searchRequestCount} 次`),
      ]
      return h('div', {
        style: cardStyle,
        'data-billing-attribution': true,
        'aria-live': 'polite',
        title: '只读计费归因；不修改思考档位、maxTokens，也不阻断请求。',
      }, rows)
    }

    function apply(ctx) {
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'billing-attribution',
        order: 15,
        label: '计费归因',
      }, BillingDock))
    }

    Object.assign(exports, { name, inject, apply })
    return module.exports
  },
})

window.__ModuleLoader__.load({
  id: 'dsh-billing-stats',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const name = 'billing-stats-client'
    const inject = ['slots']

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-dsh-billing-css]') !== null) return
      const style = document.createElement('style')
      style.dataset.dshBillingCss = 'true'
      style.textContent = `
[data-billing-composer-pill-root]{min-width:0;display:inline-flex}
[data-billing-composer-pill],[data-billing-turn-pill]{box-sizing:border-box;corner-shape:round;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}
[data-billing-composer-pill]{font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
[data-billing-turn-pill]{height:calc(28px + var(--dsh-content-font-delta,0px));font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(24px + var(--dsh-content-font-delta,0px));padding:6px 8px;gap:4px}
[data-billing-composer-pill] svg,[data-billing-turn-pill] svg{flex:none;width:14px;height:14px}
[data-billing-composer-pill]:hover,[data-billing-composer-pill][aria-expanded=true],[data-billing-turn-pill]:hover,[data-billing-turn-pill][aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
[data-billing-turn-cost]{min-width:0;display:inline-flex}
[data-turn-tail]:has([data-billing-turn-cost]) button[aria-haspopup="dialog"]:not([data-billing-turn-pill]){display:none!important}
[data-turn-tail] [data-billing-turn-cost]{order:20}
[data-turn-tail] [data-clock=end]>span:last-child{order:30}
[data-billing-cost-panel]{box-sizing:border-box;z-index:1100;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}
[data-billing-cost-panel] .billing-head{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex;align-items:center}
[data-billing-cost-panel] .billing-head-label{align-items:center;gap:6px;min-width:0;display:inline-flex}
[data-billing-cost-panel] .billing-head-label svg{flex:none;width:14px;height:14px}
[data-billing-cost-panel] .billing-head-value{font-variant-numeric:tabular-nums;white-space:nowrap}
[data-billing-cost-panel] .billing-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}
[data-billing-cost-panel] .billing-details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(84px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}
[data-billing-cost-panel] .billing-details dt,[data-billing-cost-panel] .billing-details dd{min-width:0;margin:0}
[data-billing-cost-panel] .billing-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}
[data-billing-cost-panel] .billing-unknown{color:var(--dsw-alias-state-warning-primary,#b26a00);margin-top:10px}
@media (width<=480px){[data-billing-composer-pill] .billing-label{display:none}}
`
      document.head.appendChild(style)
    }

    function formatMoney(micros) {
      const amount = Math.max(0, Number.isFinite(micros) ? micros : 0) / 1e6
      const digits = amount >= 1 ? 2 : amount >= 0.01 ? 4 : 6
      return `¥${amount.toFixed(digits)}`
    }

    function formatCost(cost) {
      const billedMicros = cost?.billedMicros ?? 0
      if (cost?.unknown !== true) return formatMoney(billedMicros)
      return billedMicros > 0 ? formatMoney(billedMicros) : '金额未知'
    }

    function costAriaLabel(cost, prefix) {
      const amount = formatCost(cost)
      const source = sourceLabel(cost)
      if (amount === '金额未知') return `${prefix}未知`
      return `${prefix} ${amount}${source === '' ? '' : `，${source}`}`
    }

    function MoneyIcon() {
      return h('svg', {
        viewBox: '0 0 16 16',
        'aria-hidden': true,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      h('circle', { cx: 8, cy: 8, r: 6.1 }),
      h('text', {
        x: 8,
        y: 11,
        textAnchor: 'middle',
        fontSize: 8,
        fontWeight: 600,
        fill: 'currentColor',
        stroke: 'none',
      }, '¥'),
      )
    }

    function cacheHitPercent(buckets) {
      const denominator = (buckets?.uncachedInputTokens ?? 0)
        + (buckets?.cacheReadTokens ?? 0)
        + (buckets?.cacheWriteTokens ?? 0)
      if (denominator <= 0) return null
      return `${((buckets.cacheReadTokens ?? 0) / denominator * 100).toFixed(1)}%`
    }

    function componentAmount(cost, key) {
      return cost?.mainComponentTotals?.[key]?.billedMicros ?? 0
    }

    const bucketByComponent = {
      uncachedInput: 'uncachedInputTokens',
      cacheRead: 'cacheReadTokens',
      cacheWrite: 'cacheWriteTokens',
      output: 'outputTokens',
    }

    function formatComponent(cost, key) {
      const amount = componentAmount(cost, key)
      const unknownComponents = cost?.unknownComponents ?? []
      const bucket = bucketByComponent[key]
      const unknown = cost?.unknown === true && (
        unknownComponents.includes('usage')
        || unknownComponents.includes(`rate:${bucket}`)
        || unknownComponents.some(value => value.endsWith(`:${bucket}`))
      )
      if (!unknown) return formatMoney(amount)
      return amount > 0 ? formatMoney(amount) : '未知'
    }

    const sourceLabels = {
      bill: '账单明细',
      usage: '官方用量',
      estimate: '文本估算',
      unknown: '未知',
    }

    function activeSources(cost) {
      return Object.entries(cost?.costSourceStats ?? {})
        .filter(([, value]) => (value?.requestCount ?? 0) > 0)
        .map(([source, value]) => ({
          source,
          label: sourceLabels[source] ?? source,
          requestCount: value.requestCount ?? 0,
          billedMicros: value.billedMicros ?? 0,
        }))
    }

    function sourceLabel(cost) {
      const sources = activeSources(cost)
      if (sources.length === 0) return ''
      if (sources.length === 1) return sources[0].label
      return '混合来源'
    }

    function sourceDetail(cost) {
      const sources = activeSources(cost)
      return sources.length === 0
        ? '未记录'
        : sources
            .map(item => `${item.label} ${formatMoney(item.billedMicros)}（${item.requestCount} 次）`)
            .join('；')
    }

    function addComponents(target, source) {
      for (const [key, value] of Object.entries(source ?? {})) {
        const current = target[key] ?? { listMicros: 0, billedMicros: 0 }
        target[key] = {
          listMicros: current.listMicros + (value.listMicros ?? 0),
          billedMicros: current.billedMicros + (value.billedMicros ?? 0),
        }
      }
    }

    function sessionCost(projection) {
      const buckets = {
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      }
      const mainComponentTotals = {}
      const searchComponentTotals = {}
      let searchBilledMicros = 0
      let searchRequestCount = 0
      let requestCount = 0
      for (const cost of Object.values(projection.turnCosts ?? {})) {
        for (const key of Object.keys(buckets)) {
          buckets[key] += cost.buckets?.[key] ?? 0
        }
        addComponents(mainComponentTotals, cost.mainComponentTotals)
        addComponents(searchComponentTotals, cost.searchComponentTotals)
        searchBilledMicros += cost.searchBilledMicros ?? 0
        searchRequestCount += cost.searchRequestCount ?? 0
        requestCount += cost.requestCount ?? 0
      }
      return {
        billedMicros: projection.billedSpentMicros,
        listMicros: projection.listSpentMicros,
        buckets,
        mainComponentTotals,
        searchComponentTotals,
        componentTotals: projection.componentTotals,
        searchBilledMicros,
        searchRequestCount,
        requestCount,
        unknown: projection.unknown,
        unknownComponents: projection.unknownComponents ?? [],
        costSourceStats: projection.costSourceStats ?? {},
      }
    }

    function CostPanel({ cost, anchorRef, onClose, title }) {
      const panelRef = React.useRef(null)
      const [position, setPosition] = React.useState(null)
      React.useEffect(() => {
        const update = () => {
          const rect = anchorRef.current?.getBoundingClientRect()
          if (rect === undefined) return
          const width = Math.min(360, window.innerWidth - 24)
          const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
          const top = rect.top > 300 ? rect.top - 270 : rect.bottom + 8
          setPosition({ left, top, width })
        }
        update()
        const onPointerDown = event => {
          if (panelRef.current?.contains(event.target)) return
          if (anchorRef.current?.contains(event.target)) return
          onClose()
        }
        const onKeyDown = event => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('resize', update)
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          window.removeEventListener('resize', update)
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [anchorRef, onClose])
      if (position === null) return null

      const cacheHit = cacheHitPercent(cost.buckets)
      const searchText = `${formatMoney(cost.searchBilledMicros)}${
        cost.searchRequestCount > 0 ? ` · ${cost.searchRequestCount} 次` : ''
      }`
      const hasBill = componentAmount(cost, 'bill') > 0
      const rows = [
        ['费用来源', sourceDetail(cost)],
        ...(hasBill
          ? [
              ['账单合计', formatMoney(componentAmount(cost, 'bill'))],
              ['公开价参考', formatMoney(cost.listMicros)],
            ]
          : [
              ...(cacheHit === null ? [] : [['缓存命中', cacheHit]]),
              ['未缓存输入', formatComponent(cost, 'uncachedInput')],
              ['缓存读取', formatComponent(cost, 'cacheRead')],
              ...(componentAmount(cost, 'cacheWrite') > 0
                ? [['缓存写入', formatComponent(cost, 'cacheWrite')]]
                : []),
              ['输出', formatComponent(cost, 'output')],
            ]),
        ['搜索', searchText],
      ]
      return ReactDOM.createPortal(
        h('div', {
          ref: panelRef,
          role: 'dialog',
          'aria-label': title,
          'data-billing-cost-panel': true,
          style: position,
        },
        h('div', { className: 'billing-head' },
          h('span', { className: 'billing-head-label' }, h(MoneyIcon), title),
          h('span', { className: 'billing-head-value' }, formatCost(cost)),
        ),
        h('div', { className: 'billing-rule', 'aria-hidden': true }),
        h('dl', { className: 'billing-details' },
          rows.flatMap(([label, value], index) => [
            h('dt', { key: `label-${index}` }, label),
            h('dd', { key: `value-${index}` }, value),
          ]),
        ),
        cost.unknown
          ? h('div', { className: 'billing-unknown' },
              '存在未定价请求：金额只统计了已有证据的部分，未定价请求会在来源明细中单列。')
          : activeSources(cost).some(item => item.source === 'estimate')
            ? h('div', { className: 'billing-unknown' },
                '含文本估算：按可见字符数折算 token，可能与供应商账单不同。')
          : null,
        ),
        document.body,
      )
    }

    function useCostDialog() {
      const [open, setOpen] = React.useState(false)
      const rootRef = React.useRef(null)
      const close = React.useCallback(() => setOpen(false), [])
      return { open, setOpen, rootRef, close }
    }

    function BillingComposerPill(props) {
      const projection = props.useProjection('billing')
      const dialog = useCostDialog()
      if (projection === undefined) return null
      const hasData = Object.keys(projection.turnCosts ?? {}).length > 0
        || projection.turnPhase === 'active'
      if (!hasData) return null
      const cost = sessionCost(projection)
      const amount = formatCost(cost)
      const source = sourceLabel(cost)
      return h('span', { ref: dialog.rootRef, 'data-billing-composer-pill-root': true },
        h('button', {
          type: 'button',
          'data-billing-composer-pill': true,
          'aria-haspopup': 'dialog',
          'aria-expanded': dialog.open,
          'aria-label': costAriaLabel(cost, '会话费用'),
          onClick: () => dialog.setOpen(!dialog.open),
        },
        h(MoneyIcon),
        h('span', { className: 'billing-label' },
          `会话 ${amount}${source === '' ? '' : ` · ${source}`}`),
        ),
        dialog.open
          ? h(CostPanel, {
              cost,
              anchorRef: dialog.rootRef,
              onClose: dialog.close,
              title: '会话费用',
            })
          : null,
      )
    }

    function turnForMessage(snapshot, messageId) {
      for (let index = snapshot.timeline.turnOrder.length - 1; index >= 0; index -= 1) {
        const turn = snapshot.timeline.turnOrder[index]
        const location = snapshot.timeline.turns.get(turn)
        const tail = location?.data?.get?.('turn-tail')
        if (tail?.closing?.finalNode?.messageId === messageId) return turn
      }
      return null
    }

    function TurnCostAction(props) {
      const turn = props.useChat(snapshot => turnForMessage(snapshot, props.messageId))
      const projection = props.useProjection('billing')
      const dialog = useCostDialog()
      if (turn === null || projection === undefined) return null
      const cost = projection.turnCosts?.[String(turn)]
      if (cost === undefined || (cost.requestCount === 0 && cost.billedMicros === 0)) return null
      const amount = formatCost(cost)
      const source = sourceLabel(cost)
      return h('span', { ref: dialog.rootRef, 'data-billing-turn-cost': true },
        h('button', {
          type: 'button',
          'data-billing-turn-pill': true,
          'aria-haspopup': 'dialog',
          'aria-expanded': dialog.open,
          'aria-label': costAriaLabel(cost, '本轮用量费用'),
          onClick: () => dialog.setOpen(!dialog.open),
        },
        h(MoneyIcon),
        h('span', { className: 'billing-label' },
          `用量 ${amount}${source === '' ? '' : ` · ${source}`}`),
        ),
        dialog.open
          ? h(CostPanel, {
              cost,
              anchorRef: dialog.rootRef,
              onClose: dialog.close,
              title: '本轮费用',
            })
          : null,
      )
    }

    function apply(ctx) {
      ensureStyles()
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'billing-stats',
        order: 10,
        label: '计费统计',
      }, BillingComposerPill))
      ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions',
        id: 'billing-turn-amount',
        order: 10,
        label: '本轮费用',
      }, TurnCostAction))
    }

    Object.assign(exports, { name, inject, apply })
    return module.exports
  },
})

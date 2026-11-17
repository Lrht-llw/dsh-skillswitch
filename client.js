/**
 * Skillswitch — browser half.
 *
 * Registers one left-sidebar panel entry (`sidebar.panellist`) and its page
 * (`main` keyed by the same id), then talks to the Host half through the
 * authenticated exact Fetch route `/api/skillswitch`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-skillswitch',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'skillswitch'
    const PANEL_ID = 'skillswitch'
    const API_PATH = '/api/skillswitch'

    const en = {
      panel: 'Skills',
      title: 'Skillswitch',
      subtitle: 'Turn installed skills on or off, or uninstall a skill you added yourself. A disabled skill leaves the model catalog immediately and the skill tool refuses it.',
      refresh: 'Refresh',
      loading: 'Reading installed skills…',
      empty: 'No skills are installed in this view.',
      enabled: 'On',
      disabled: 'Off',
      enable: 'Turn on',
      disable: 'Turn off',
      uninstall: 'Uninstall',
      confirmUninstall: 'Confirm uninstall',
      cancel: 'Cancel',
      removable: 'removable',
      builtinOnly: 'shipped — disable only',
      footer: 'Shipped and packaged skills can only be turned off. Uninstalling removes the skill directory from your user skill folders.',
      requestFailed: 'Request failed',
      stateFile: 'Switch state',
      count: (total, off) => `${total} skills · ${total - off} on · ${off} off`,
    }

    const zh = {
      panel: '技能',
      title: '技能开关',
      subtitle: '开启或关闭已安装的技能，也可以卸载你自己安装的技能。关闭后它会立刻从模型技能目录消失，skill 工具也会拒绝加载它。',
      refresh: '刷新',
      loading: '正在读取已安装的技能…',
      empty: '当前视角没有已安装的技能。',
      enabled: '已开启',
      disabled: '已关闭',
      enable: '开启',
      disable: '关闭',
      uninstall: '卸载',
      confirmUninstall: '确认卸载',
      cancel: '取消',
      removable: '可卸载',
      builtinOnly: '内置/打包，仅可关闭',
      footer: '内置与打包技能只能关闭；卸载会从你的用户技能目录中删除该技能的全部文件。',
      requestFailed: '请求失败',
      stateFile: '开关状态文件',
      count: (total, off) => `共 ${total} 个技能 · 已开启 ${total - off} 个 · 已关闭 ${off} 个`,
    }

    async function post(body) {
      const response = await fetch(API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null) throw new Error(`HTTP ${response.status}`)
      if (response.ok !== true && payload.ok !== true) throw new Error(payload.message || `HTTP ${response.status}`)
      return payload
    }

    function SkillManagerIcon({ size = 18 }) {
      return h('svg', {
        viewBox: '0 0 36 36',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block' },
      },
      h('rect', { x: 4.5, y: 6.5, width: 15, height: 23, rx: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 2 }),
      h('path', { d: 'M9 12.5h6M9 18h6M9 23.5h4', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
      h('rect', { x: 23.5, y: 9, width: 9, height: 5.5, rx: 2.75, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }),
      h('circle', { cx: 30, cy: 11.75, r: 1.9, fill: 'currentColor' }),
      h('rect', { x: 23.5, y: 22, width: 9, height: 5.5, rx: 2.75, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }),
      h('circle', { cx: 26, cy: 24.75, r: 1.9, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }))
    }

    const styles = {
      page: {
        height: '100%',
        overflowY: 'auto',
        padding: '28px 32px 56px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
      },
      inner: { maxWidth: '880px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '18px' },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' },
      title: { margin: 0, fontSize: '20px', fontWeight: 600, lineHeight: 1.3 },
      subtitle: { margin: '6px 0 0', fontSize: '13px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.55, maxWidth: '640px' },
      meta: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      list: { display: 'flex', flexDirection: 'column', gap: '10px' },
      card: {
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '14px',
      },
      cardMain: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '5px' },
      nameRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      name: { fontSize: '14px', fontWeight: 600, wordBreak: 'break-all' },
      badge: { fontSize: '11px', lineHeight: 1.4, padding: '1px 7px', borderRadius: '999px', border: '1px solid currentColor' },
      description: { margin: 0, fontSize: '13px', lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' },
      origin: { margin: 0, fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      actions: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' },
      textButton: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: '7px',
        padding: '5px 10px',
        fontSize: '12px',
        cursor: 'pointer',
      },
      dangerButton: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        borderRadius: '7px',
        padding: '5px 10px',
        fontSize: '12px',
        cursor: 'pointer',
      },
      switch: (checked, busy) => ({
        appearance: 'none',
        width: '38px',
        height: '22px',
        borderRadius: '999px',
        border: `1px solid ${checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`,
        background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
        position: 'relative',
        padding: 0,
        cursor: busy ? 'progress' : 'pointer',
        flex: '0 0 auto',
        opacity: busy ? 0.6 : 1,
      }),
      knob: checked => ({
        position: 'absolute',
        top: '2px',
        left: checked ? '18px' : '2px',
        width: '16px',
        height: '16px',
        borderRadius: '999px',
        background: '#ffffff',
        transition: 'left 120ms ease',
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.25)',
      }),
      notice: ok => ({
        border: `1px solid ${ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)'}`,
        color: ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: '8px',
        padding: '9px 12px',
        fontSize: '12px',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
      }),
      loading: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' },
      footer: { margin: 0, fontSize: '11px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
    }

    function Badge({ label, color }) {
      return h('span', { style: { ...styles.badge, color } }, label)
    }

    function Toggle({ checked, busy, label, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        title: label,
        disabled: busy,
        onClick: onChange,
        style: styles.switch(checked, busy),
      }, h('span', { style: styles.knob(checked) }))
    }

    function SkillRow({ skill, t, busy, confirming, onToggle, onUninstall, onCancelUninstall }) {
      const [open, setOpen] = useState(false)
      useEffect(() => {
        if (!open) return undefined
        const timer = setTimeout(() => { setOpen(false) }, 4000)
        return () => { clearTimeout(timer) }
      }, [open])
      const rowBusy = busy === skill.name
      const statusColor = skill.disabled
        ? 'var(--dsw-alias-state-idle-primary)'
        : 'var(--dsw-alias-state-success-primary)'
      return h('div', { style: styles.card },
        h('div', { style: styles.cardMain },
          h('div', { style: styles.nameRow },
            h('span', { style: styles.name }, skill.name),
            h(Badge, { label: skill.disabled ? t('disabled') : t('enabled'), color: statusColor }),
            h(Badge, {
              label: skill.removable ? t('removable') : t('builtinOnly'),
              color: 'var(--dsw-alias-label-secondary)',
            })),
          skill.description !== ''
            ? h('p', { style: styles.description }, skill.description)
            : null,
          h('p', { style: styles.origin }, `${skill.source}${skill.provider ? ` · ${skill.provider}` : ''}`)),
        h('div', { style: styles.actions },
          h(Toggle, {
            checked: !skill.disabled,
            busy: rowBusy,
            label: skill.disabled ? `${t('enable')} ${skill.name}` : `${t('disable')} ${skill.name}`,
            onChange: () => { onToggle(skill, skill.disabled) },
          }),
          skill.removable
            ? h('button', {
              type: 'button',
              disabled: rowBusy,
              style: open ? styles.dangerButton : styles.textButton,
              onClick: () => {
                if (open) {
                  setOpen(false)
                  onUninstall(skill)
                } else {
                  setOpen(true)
                }
              },
              onBlur: () => { if (!confirming) setOpen(false) },
              title: skill.path || '',
            },
              open ? t('confirmUninstall') : t('uninstall'))
            : null))
    }

    function SkillManagerPage(props) {
      const injected = props !== null && typeof props === 'object' ? props : {}
      const t = typeof injected.t === 'function' ? injected.t : key => key
      const [snapshot, setSnapshot] = useState({ status: 'loading', skills: [], statePath: '' })
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState('')
      const [confirming, setConfirming] = useState('')
      const mounted = useRef(true)

      useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])

      const load = useCallback(async () => {
        setSnapshot(current => ({ ...current, status: current.skills.length > 0 ? 'ready' : 'loading' }))
        try {
          const payload = await post({ action: 'list' })
          if (!mounted.current) return
          setSnapshot({
            status: 'ready',
            skills: Array.isArray(payload.skills) ? payload.skills : [],
            statePath: typeof payload.statePath === 'string' ? payload.statePath : '',
          })
        } catch (error) {
          if (!mounted.current) return
          setSnapshot(current => ({ ...current, status: 'error' }))
          setNotice({ ok: false, message: `${t('requestFailed')}: ${String(error?.message ?? error)}` })
        }
      }, [t])

      useEffect(() => { void load() }, [load])

      const run = useCallback(async (body, successMessage) => {
        setBusy(body.name ?? body.action)
        setNotice(null)
        try {
          const payload = await post(body)
          if (payload.ok === true && typeof payload.message === 'string' && payload.message !== '') {
            setNotice({ ok: true, message: payload.message })
          } else if (payload.ok !== true) {
            setNotice({ ok: false, message: `${t('requestFailed')}: ${payload.message ?? ''}` })
          }
          await load()
        } catch (error) {
          setNotice({ ok: false, message: `${t('requestFailed')}: ${String(error?.message ?? error)}` })
        } finally {
          if (mounted.current) setBusy('')
        }
      }, [load, t])

      const onToggle = useCallback((skill, enable) => {
        void run({ action: 'setEnabled', name: skill.name, enabled: enable })
      }, [run])

      const onUninstall = useCallback((skill) => {
        setConfirming(skill.name)
        void run({ action: 'uninstall', name: skill.name })
      }, [run])

      const offCount = useMemo(() => snapshot.skills.filter(skill => skill.disabled === true).length, [snapshot.skills])

      return h('div', { style: styles.page },
        h('div', { style: styles.inner },
          h('div', { style: styles.header },
            h('div', null,
              h('h1', { style: styles.title }, t('title')),
              h('p', { style: styles.subtitle }, t('subtitle'))),
            h('button', {
              type: 'button',
              style: styles.textButton,
              disabled: snapshot.status === 'loading',
              onClick: () => { void load() },
            }, t('refresh'))),
          notice !== null ? h('div', { style: styles.notice(notice.ok) }, notice.message) : null,
          snapshot.status === 'loading'
            ? h('div', { style: styles.loading }, t('loading'))
            : snapshot.status === 'error'
              ? null
              : snapshot.skills.length === 0
                ? h('div', { style: styles.loading }, t('empty'))
                : h('div', { style: styles.list },
                  h('p', { style: styles.meta }, t('count')(snapshot.skills.length, offCount)),
                  snapshot.skills.map(skill => h(SkillRow, {
                    key: skill.name,
                    skill,
                    t,
                    busy,
                    confirming,
                    onToggle,
                    onUninstall,
                    onCancelUninstall: () => { setConfirming('') },
                  }))),
          h('p', { style: styles.footer }, t('footer')),
          snapshot.statePath !== ''
            ? h('p', { style: styles.footer }, `${t('stateFile')}: ${snapshot.statePath}`)
            : null))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'skillswitch: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ t }),
        }, SkillManagerPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 5,
          locale: NS,
          label: () => t('panel'),
        }, SkillManagerIcon))
      },
    }
  },
})

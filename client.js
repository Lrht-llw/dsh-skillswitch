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
      checkUpdate: 'Check for updates',
      checking: 'Checking…',
      upToDate: version => `Up to date (v${version})`,
      updateAvailable: (current, latest) => `Version ${latest} is available (installed ${current})`,
      openPlugins: 'Open Plugins to update',
      updateFailed: 'Update check failed',
      version: version => (version ? `v${version}` : ''),
      managedGroup: 'Your skills',
      builtinGroup: 'Shipped and packaged',
      builtinGroupMeta: 'switchable only',
      noManaged: 'No user-installed skills in this view.',
      viewSession: (agent, cwd) => `Viewing session ${agent} · ${cwd}`,
      viewGlobal: 'Global view (no active session)',
      searchPlaceholder: 'Search skills…',
      filterAll: 'All',
      filterOn: 'On',
      filterOff: 'Off',
      noMatch: 'No skill matches the current search or filter.',
      view: 'View',
      previewPath: 'Path',
      previewLoading: 'Loading skill body…',
      previewFailed: 'Cannot load skill body',
      previewEmpty: 'This skill has no body text.',
      previewTruncated: 'Body truncated for display.',
      export: 'Export',
      exported: name => `Exported ${name}.`,
      exportFailed: 'Export failed',
      exportSelected: 'Export',
      exportSelectedCount: count => `Export selected (${count})`,
      selectAll: 'Select all',
      clearSelection: 'Clear',
      cancelSelection: 'Cancel',
      exporting: 'Exporting…',
      selectHint: 'Select the skills to export, then press Export selected.',
      exportEmpty: 'Select at least one skill.',
      exportedCount: count => `Exported ${count} skill(s).`,
      importPack: 'Import skill pack',
      importing: 'Importing…',
      importFailed: 'Import failed',
      importInvalid: 'Not a valid skill pack file.',
      loads: count => `${count} loads`,
      neverLoaded: 'never loaded',
      settings: 'Settings',
      policyLabel: 'When the model calls a disabled skill',
      policyAsk: 'Ask the user first',
      policyDeny: 'Refuse — user enables',
      policyAllow: 'Allow the model to enable',
      policyHint: 'This changes what the skill tool answers and whether the agent may enable a skill on its own.',
      backupLabel: 'Back up uninstalled skills to trash',
      backupHint: 'Off: uninstall deletes the files immediately. On: the folder moves to skillswitch/trash and can be restored below.',
      clearStats: 'Clear usage stats',
      statsCleared: 'Usage stats cleared.',
      trash: 'Trash',
      trashEmpty: 'Trash is empty.',
      trashCount: count => `${count} uninstalled skill(s) kept`,
      restore: 'Restore',
      deleteForever: 'Delete',
      emptyTrash: 'Empty trash',
      removedAt: when => `removed ${when}`,
      entries: count => `${count} path(s)`,
      confirmEmptyTrash: 'Click again to empty the trash for good',
      saved: 'Saved.',
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
      checkUpdate: '检查更新',
      checking: '检查中…',
      upToDate: version => `已是最新版本（v${version}）`,
      updateAvailable: (current, latest) => `发现新版本 ${latest}（当前 ${current}）`,
      openPlugins: '打开插件页更新',
      updateFailed: '检查更新失败',
      version: version => (version ? `v${version}` : ''),
      managedGroup: '可管理的技能',
      builtinGroup: '内置与打包技能',
      builtinGroupMeta: '仅可开关',
      noManaged: '当前没有可管理的用户技能。',
      viewSession: (agent, cwd) => `当前视角：会话 ${agent} · ${cwd}`,
      viewGlobal: '全局视角（没有活跃会话）',
      searchPlaceholder: '搜索技能…',
      filterAll: '全部',
      filterOn: '已开启',
      filterOff: '已关闭',
      noMatch: '没有匹配当前搜索或筛选的技能。',
      view: '查看',
      previewPath: '路径',
      previewLoading: '正在加载技能正文…',
      previewFailed: '无法加载技能正文',
      previewEmpty: '该技能没有正文内容。',
      previewTruncated: '正文过长，已截断显示。',
      export: '导出',
      exported: name => `已导出 ${name}。`,
      exportFailed: '导出失败',
      exportSelected: '导出',
      exportSelectedCount: count => `导出所选（${count}）`,
      selectAll: '全选',
      clearSelection: '清除',
      cancelSelection: '取消',
      exporting: '导出中…',
      selectHint: '勾选要导出的技能，然后点「导出所选」。',
      exportEmpty: '请先选择至少一个技能。',
      exportedCount: count => `已导出 ${count} 个技能。`,
      importPack: '导入技能包',
      importing: '导入中…',
      importFailed: '导入失败',
      importInvalid: '不是有效的技能包文件。',
      loads: count => `加载 ${count} 次`,
      neverLoaded: '从未加载',
      settings: '设置',
      policyLabel: '模型调用已关闭技能时',
      policyAsk: '先询问用户',
      policyDeny: '拒绝，必须由用户开启',
      policyAllow: '允许模型自行开启',
      policyHint: '这项设置决定 skill 工具返回的提示，以及 agent 是否可以自行开启技能。',
      backupLabel: '卸载前备份到回收站',
      backupHint: '关闭：卸载直接删除文件。开启：目录会移入 skillswitch/trash，可在下方恢复。',
      clearStats: '清除使用统计',
      statsCleared: '使用统计已清除。',
      trash: '回收站',
      trashEmpty: '回收站为空。',
      trashCount: count => `保留了 ${count} 个已卸载技能`,
      restore: '恢复',
      deleteForever: '彻底删除',
      emptyTrash: '清空回收站',
      removedAt: when => `删除于 ${when}`,
      entries: count => `${count} 个路径`,
      confirmEmptyTrash: '再次点击以彻底清空回收站',
      saved: '已保存。',
    }

    function formatWhen(timestamp) {
      if (typeof timestamp !== 'number' || timestamp <= 0) return '—'
      try {
        return new Date(timestamp).toLocaleString()
      } catch {
        return '—'
      }
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

    const baseButton = {
      appearance: 'none',
      outline: 'none',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      borderRadius: '7px',
      padding: '5px 10px',
      fontSize: '12px',
      cursor: 'pointer',
    }

    const styles = {
      page: {
        height: '100%',
        overflowY: 'auto',
        padding: '28px 32px 56px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
      },
      inner: { maxWidth: '900px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '16px' },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' },
      title: { margin: 0, fontSize: '20px', fontWeight: 600, lineHeight: 1.3 },
      subtitle: { margin: '6px 0 0', fontSize: '13px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.55, maxWidth: '620px' },
      meta: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      viewLine: { margin: 0, fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' },
      headerActions: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto', flexWrap: 'wrap' },
      textButton: baseButton,
      tinyButton: { ...baseButton, padding: '3px 8px', fontSize: '11px' },
      linkButton: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)',
        cursor: 'pointer',
        padding: 0,
        font: 'inherit',
        textDecoration: 'underline',
      },
      toolbar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'space-between' },
      search: {
        flex: '1 1 240px',
        minWidth: '180px',
        padding: '7px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        outline: 'none',
      },
      filterGroup: { display: 'flex', gap: '4px' },
      filterButton: active => ({
        ...baseButton,
        borderColor: active ? 'var(--dsw-alias-brand-primary)' : 'transparent',
        color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
        background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
      }),
      list: { display: 'flex', flexDirection: 'column', gap: '10px' },
      group: { display: 'flex', flexDirection: 'column', gap: '8px' },
      sectionLabel: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      groupHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        width: '100%',
        padding: '9px 12px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        fontSize: '13px',
        fontWeight: 600,
        textAlign: 'left',
      },
      groupHeaderRight: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '12px',
        fontWeight: 400,
        color: 'var(--dsw-alias-label-secondary)',
      },
      card: {
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '14px',
      },
      cardWrap: { display: 'flex', flexDirection: 'column' },
      cardMain: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '5px' },
      nameRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      name: { fontSize: '14px', fontWeight: 600, wordBreak: 'break-all' },
      badge: { fontSize: '11px', lineHeight: 1.4, padding: '1px 7px', borderRadius: '999px', border: '1px solid currentColor' },
      description: { margin: 0, fontSize: '13px', lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' },
      origin: { margin: 0, fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' },
      actions: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto', flexWrap: 'wrap', justifyContent: 'flex-end' },
      dangerButton: { ...baseButton, borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' },
      switchTrack: (checked, busy) => ({
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
      preview: {
        margin: 0,
        padding: '10px 14px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-2)',
        fontSize: '12px',
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        overflow: 'auto',
        maxHeight: '360px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        color: 'var(--dsw-alias-label-primary)',
      },
      previewMeta: { margin: '4px 0 0', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' },
      panel: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      },
      panelHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        width: '100%',
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
        textAlign: 'left',
      },
      panelBody: { display: 'flex', flexDirection: 'column', gap: '8px' },
      settingRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      radioGroup: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      hint: { margin: 0, fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      trashRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: '12px', flexWrap: 'wrap' },
      trashMeta: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      trashActions: { display: 'flex', gap: '6px', alignItems: 'center' },
      updateNote: { fontSize: '12px', lineHeight: 1.5 },
      visuallyHidden: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)' },
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
        style: styles.switchTrack(checked, busy),
      }, h('span', { style: styles.knob(checked) }))
    }

    function SkillRow({ skill, t, busy, expanded, preview, selecting, selected, onToggle, onUninstall, onView, onSelect }) {
      const [confirmOpen, setConfirmOpen] = useState(false)
      useEffect(() => {
        if (!confirmOpen) return undefined
        const timer = setTimeout(() => { setConfirmOpen(false) }, 4000)
        return () => { clearTimeout(timer) }
      }, [confirmOpen])
      const rowBusy = busy === skill.name
      const statusColor = skill.disabled
        ? 'var(--dsw-alias-state-idle-primary)'
        : 'var(--dsw-alias-state-success-primary)'
      const usage = skill.loads > 0 ? t('loads')(skill.loads) : t('neverLoaded')
      return h('div', { style: styles.cardWrap },
        h('div', { style: styles.card },
          selecting
            ? h('input', {
                type: 'checkbox',
                checked: selected === true,
                disabled: skill.removable !== true,
                title: skill.removable === true ? skill.name : t('builtinOnly'),
                'aria-label': skill.name,
                onChange: () => { onSelect(skill) },
                style: {
                  marginTop: '3px',
                  flex: '0 0 auto',
                  accentColor: 'var(--dsw-alias-brand-primary)',
                  cursor: skill.removable === true ? 'pointer' : 'not-allowed',
                },
              })
            : null,
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
            h('p', { style: styles.origin }, `${skill.source}${skill.provider ? ` · ${skill.provider}` : ''} · ${usage}`)),
          h('div', { style: styles.actions },
            h('button', {
              type: 'button',
              style: styles.tinyButton,
              disabled: preview !== undefined && preview.loading === true,
              onClick: () => { onView(skill) },
            }, expanded ? t('cancel') : t('view')),
            skill.removable
              ? h('button', {
                type: 'button',
                disabled: rowBusy,
                style: confirmOpen ? styles.dangerButton : styles.tinyButton,
                onClick: () => {
                  if (confirmOpen) {
                    setConfirmOpen(false)
                    onUninstall(skill)
                  } else {
                    setConfirmOpen(true)
                  }
                },
                onBlur: () => { if (!confirmOpen) setConfirmOpen(false) },
                title: skill.path || '',
              }, confirmOpen ? t('confirmUninstall') : t('uninstall'))
              : null,
            h(Toggle, {
              checked: !skill.disabled,
              busy: rowBusy,
              label: skill.disabled ? `${t('enable')} ${skill.name}` : `${t('disable')} ${skill.name}`,
              onChange: () => { onToggle(skill, skill.disabled) },
            }))),
        expanded
          ? h('pre', { style: styles.preview },
            preview !== undefined && preview.loading === true
              ? t('previewLoading')
              : preview !== undefined && typeof preview.message === 'string' && preview.message !== ''
                ? preview.message
                : preview !== undefined && typeof preview.content === 'string' && preview.content !== ''
                  ? preview.content
                  : t('previewEmpty'))
          : null,
        expanded && preview !== undefined && preview.path
          ? h('p', { style: styles.previewMeta }, `${t('previewPath')}: ${preview.path}`)
          : null,
        expanded && preview !== undefined && preview.truncated === true
          ? h('p', { style: styles.previewMeta }, t('previewTruncated'))
          : null)
    }

    function SkillManagerPage(props) {
      const injected = props !== null && typeof props === 'object' ? props : {}
      const t = typeof injected.t === 'function' ? injected.t : key => key
      const openPlugins = typeof injected.openPlugins === 'function' ? injected.openPlugins : () => {}
      const [snapshot, setSnapshot] = useState({
        status: 'loading',
        skills: [],
        statePath: '',
        version: '',
        view: null,
        settings: { disabledSkillPolicy: 'ask', backupOnUninstall: false },
        trash: [],
      })
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState('')
      const [query, setQuery] = useState('')
      const [filter, setFilter] = useState('all')
      const [builtinOpen, setBuiltinOpen] = useState(false)
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [trashOpen, setTrashOpen] = useState(false)
      const [preview, setPreview] = useState(null)
      const [update, setUpdate] = useState({ status: 'idle' })
      const [confirmEmptyTrash, setConfirmEmptyTrash] = useState(false)
      const [selecting, setSelecting] = useState(false)
      const [selected, setSelected] = useState([])
      const mounted = useRef(true)
      const fileInput = useRef(null)

      useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])

      useEffect(() => {
        if (!confirmEmptyTrash) return undefined
        const timer = setTimeout(() => { setConfirmEmptyTrash(false) }, 4000)
        return () => { clearTimeout(timer) }
      }, [confirmEmptyTrash])

      const load = useCallback(async () => {
        setSnapshot(current => ({ ...current, status: current.skills.length > 0 ? 'ready' : 'loading' }))
        try {
          const payload = await post({ action: 'list' })
          if (!mounted.current) return
          setSnapshot({
            status: 'ready',
            skills: Array.isArray(payload.skills) ? payload.skills : [],
            statePath: typeof payload.statePath === 'string' ? payload.statePath : '',
            version: typeof payload.version === 'string' ? payload.version : '',
            view: payload.view !== undefined && payload.view !== null ? payload.view : null,
            settings: payload.settings !== undefined && payload.settings !== null
              ? payload.settings
              : { disabledSkillPolicy: 'ask', backupOnUninstall: false },
            trash: Array.isArray(payload.trash) ? payload.trash : [],
          })
        } catch (error) {
          if (!mounted.current) return
          setSnapshot(current => ({ ...current, status: 'error' }))
          setNotice({ ok: false, message: `${t('requestFailed')}: ${String(error?.message ?? error)}` })
        }
      }, [t])

      useEffect(() => { void load() }, [load])

      const run = useCallback(async (body) => {
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
        void run({ action: 'uninstall', name: skill.name })
      }, [run])

      const onView = useCallback(async (skill) => {
        if (preview !== null && preview.name === skill.name) {
          setPreview(null)
          return
        }
        setPreview({ name: skill.name, loading: true, content: '', path: '', truncated: false })
        try {
          const payload = await post({ action: 'readSkill', name: skill.name })
          if (!mounted.current) return
          if (payload.ok !== true) {
            setPreview({ name: skill.name, loading: false, content: '', path: '', message: String(payload.message ?? t('previewFailed')) })
            return
          }
          setPreview({
            name: skill.name,
            loading: false,
            content: typeof payload.content === 'string' ? payload.content : '',
            path: typeof payload.path === 'string' ? payload.path : '',
            truncated: payload.truncated === true,
          })
        } catch (error) {
          if (!mounted.current) return
          setPreview({ name: skill.name, loading: false, content: '', path: '', message: `${t('previewFailed')}: ${String(error?.message ?? error)}` })
        }
      }, [preview, t])

      const toggleSelected = useCallback((skill) => {
        if (skill.removable !== true) return
        setSelected(current => current.includes(skill.name)
          ? current.filter(name => name !== skill.name)
          : [...current, skill.name])
      }, [])

      const selectAllExportable = useCallback(() => {
        setSelected(snapshot.skills.filter(skill => skill.removable === true).map(skill => skill.name))
      }, [snapshot.skills])

      const cancelSelection = useCallback(() => {
        setSelecting(false)
        setSelected([])
      }, [])

      const exportSelected = useCallback(async () => {
        if (selected.length === 0) {
          setNotice({ ok: false, message: t('exportEmpty') })
          return
        }
        setBusy('export')
        setNotice(null)
        try {
          const payload = await post({ action: 'exportSkills', names: selected })
          if (payload.ok !== true) {
            setNotice({ ok: false, message: String(payload.message ?? t('exportFailed')) })
            return
          }
          const binary = atob(String(payload.dataBase64 ?? ''))
          const bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
          const blob = new Blob([bytes], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = typeof payload.fileName === 'string' ? payload.fileName : 'skillswitch-pack.skillpack.json'
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => { URL.revokeObjectURL(url) }, 5000)
          const skipped = Array.isArray(payload.skipped) ? payload.skipped : []
          const baseMessage = typeof payload.message === 'string' ? payload.message : t('exportedCount')(selected.length)
          setNotice({
            ok: true,
            message: skipped.length > 0 ? `${baseMessage}（${skipped.map(item => item.name).join('、')}）` : baseMessage,
          })
          cancelSelection()
        } catch (error) {
          setNotice({ ok: false, message: `${t('exportFailed')}: ${String(error?.message ?? error)}` })
        } finally {
          if (mounted.current) setBusy('')
        }
      }, [cancelSelection, selected, t])

      const onImportFile = useCallback(async (file) => {
        setBusy('import')
        setNotice(null)
        try {
          const text = await file.text()
          let pack
          try {
            pack = JSON.parse(text)
          } catch {
            setNotice({ ok: false, message: t('importInvalid') })
            return
          }
          const payload = await post({ action: 'importPack', pack })
          if (payload.ok !== true) {
            setNotice({ ok: false, message: `${t('importFailed')}: ${String(payload.message ?? '')}` })
            return
          }
          setNotice({ ok: true, message: String(payload.message ?? '') })
          await load()
        } catch (error) {
          setNotice({ ok: false, message: `${t('importFailed')}: ${String(error?.message ?? error)}` })
        } finally {
          if (mounted.current) setBusy('')
        }
      }, [load, t])

      const checkForUpdate = useCallback(async () => {
        setUpdate({ status: 'checking' })
        try {
          const payload = await post({ action: 'checkUpdate' })
          if (!mounted.current) return
          if (payload.ok !== true) {
            setUpdate({ status: 'error', message: String(payload.message ?? t('updateFailed')) })
            return
          }
          setUpdate({
            status: payload.updateAvailable === true ? 'available' : 'current',
            current: typeof payload.current === 'string' ? payload.current : '',
            latest: typeof payload.latest === 'string' ? payload.latest : '',
          })
        } catch (error) {
          if (!mounted.current) return
          setUpdate({ status: 'error', message: `${t('updateFailed')}: ${String(error?.message ?? error)}` })
        }
      }, [t])

      const updatePolicy = useCallback((policy) => {
        void run({ action: 'updateSettings', settings: { disabledSkillPolicy: policy } })
      }, [run])

      const toggleBackup = useCallback(() => {
        void run({
          action: 'updateSettings',
          settings: { backupOnUninstall: snapshot.settings.backupOnUninstall !== true },
        })
      }, [run, snapshot.settings.backupOnUninstall])

      const offCount = useMemo(() => snapshot.skills.filter(skill => skill.disabled === true).length, [snapshot.skills])
      const filteredSkills = useMemo(() => {
        const needle = query.trim().toLowerCase()
        return snapshot.skills.filter((skill) => {
          if (filter === 'on' && skill.disabled === true) return false
          if (filter === 'off' && skill.disabled !== true) return false
          if (needle === '') return true
          const haystack = `${skill.name} ${skill.description} ${skill.source} ${skill.provider}`.toLowerCase()
          return haystack.includes(needle)
        })
      }, [snapshot.skills, query, filter])
      const managedSkills = useMemo(() => filteredSkills.filter(skill => skill.removable === true), [filteredSkills])
      const builtinSkills = useMemo(() => filteredSkills.filter(skill => skill.removable !== true), [filteredSkills])
      const builtinVisible = builtinOpen || (query.trim() !== '' && builtinSkills.length > 0)
      const row = skill => h(SkillRow, {
        key: skill.name,
        skill,
        t,
        busy,
        expanded: preview !== null && preview.name === skill.name,
        preview: preview !== null && preview.name === skill.name ? preview : undefined,
        selecting,
        selected: selected.includes(skill.name),
        onToggle,
        onUninstall,
        onView,
        onSelect: toggleSelected,
      })

      const updateSummary = update.status === 'checking'
        ? t('checking')
        : update.status === 'available'
          ? t('updateAvailable')(update.current, update.latest)
          : update.status === 'current'
            ? t('upToDate')(update.current)
            : update.status === 'error'
              ? update.message
              : ''
      const updateStyle = update.status === 'available'
        ? styles.notice(true)
        : update.status === 'error'
          ? styles.notice(false)
          : {
              ...styles.notice(true),
              color: 'var(--dsw-alias-label-secondary)',
              border: '1px solid var(--dsw-alias-border-l1)',
            }
      const viewLine = snapshot.view !== null && snapshot.view !== undefined
        ? snapshot.view.mode === 'session'
          ? t('viewSession')(String(snapshot.view.agent).slice(0, 8), snapshot.view.cwd)
          : t('viewGlobal')
        : ''

      return h('div', { style: styles.page, className: 'skillswitch-page' },
        h('style', { key: 'skillswitch-focus' }, [
          '.skillswitch-page button:focus, .skillswitch-page button:focus-visible { outline: none !important; box-shadow: none !important; }',
          '.skillswitch-page input:focus { outline: none; box-shadow: none; }',
          '.skillswitch-page input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }',
        ].join('\n')),
        h('div', { style: styles.inner },
          h('div', { style: styles.header },
            h('div', null,
              h('h1', { style: styles.title }, t('title')),
              h('p', { style: styles.subtitle }, t('subtitle')),
              snapshot.version !== ''
                ? h('p', { style: styles.meta }, t('version')(snapshot.version))
                : null,
              viewLine !== '' ? h('p', { style: styles.viewLine }, viewLine) : null),
            h('div', { style: styles.headerActions },
              h('input', {
                ref: fileInput,
                type: 'file',
                accept: '.json,application/json',
                style: styles.visuallyHidden,
                onChange: (event) => {
                  const file = event.target.files && event.target.files[0]
                  event.target.value = ''
                  if (file) void onImportFile(file)
                },
              }),
              h('button', {
                type: 'button',
                style: styles.textButton,
                disabled: busy === 'import',
                onClick: () => { if (fileInput.current) fileInput.current.click() },
              }, busy === 'import' ? t('importing') : t('importPack')),
              selecting
                ? h('button', {
                    type: 'button',
                    style: styles.textButton,
                    disabled: busy === 'export' || selected.length === 0,
                    onClick: () => { void exportSelected() },
                  }, busy === 'export' ? t('exporting') : t('exportSelectedCount')(selected.length))
                : h('button', {
                    type: 'button',
                    style: styles.textButton,
                    onClick: () => { setSelecting(true) },
                  }, t('exportSelected')),
              selecting
                ? h('button', { type: 'button', style: styles.textButton, onClick: selectAllExportable }, t('selectAll'))
                : null,
              selecting
                ? h('button', { type: 'button', style: styles.textButton, onClick: () => { setSelected([]) } }, t('clearSelection'))
                : null,
              selecting
                ? h('button', { type: 'button', style: styles.textButton, onClick: cancelSelection }, t('cancelSelection'))
                : null,
              h('button', {
                type: 'button',
                style: styles.textButton,
                disabled: update.status === 'checking',
                onClick: () => { void checkForUpdate() },
              }, update.status === 'checking' ? t('checking') : t('checkUpdate')),
              h('button', {
                type: 'button',
                style: styles.textButton,
                disabled: snapshot.status === 'loading',
                onClick: () => { void load() },
              }, t('refresh')))),
          update.status !== 'idle'
            ? h('div', { style: updateStyle },
              h('span', { style: styles.updateNote }, updateSummary),
              update.status === 'available'
                ? h('button', {
                    type: 'button',
                    style: { ...styles.linkButton, marginLeft: '10px' },
                    onClick: () => { openPlugins() },
                  }, t('openPlugins'))
                : null)
            : null,
          h('div', { style: styles.toolbar },
            h('input', {
              type: 'search',
              value: query,
              placeholder: t('searchPlaceholder'),
              'aria-label': t('searchPlaceholder'),
              onChange: (event) => { setQuery(event.target.value) },
              style: styles.search,
            }),
            h('div', { style: styles.filterGroup },
              h('button', { type: 'button', style: styles.filterButton(filter === 'all'), onClick: () => { setFilter('all') } }, t('filterAll')),
              h('button', { type: 'button', style: styles.filterButton(filter === 'on'), onClick: () => { setFilter('on') } }, t('filterOn')),
              h('button', { type: 'button', style: styles.filterButton(filter === 'off'), onClick: () => { setFilter('off') } }, t('filterOff')))),
          notice !== null ? h('div', { style: styles.notice(notice.ok) }, notice.message) : null,
          selecting ? h('p', { style: styles.hint }, t('selectHint')) : null,
          snapshot.status === 'loading'
            ? h('div', { style: styles.loading }, t('loading'))
            : snapshot.status === 'error'
              ? null
              : snapshot.skills.length === 0
                ? h('div', { style: styles.loading }, t('empty'))
                : h('div', { style: styles.group },
                  h('p', { style: styles.meta }, t('count')(snapshot.skills.length, offCount)),
                  h('p', { style: styles.sectionLabel }, t('managedGroup')),
                  managedSkills.length === 0
                    ? h('div', { style: styles.loading }, query.trim() !== '' || filter !== 'all' ? t('noMatch') : t('noManaged'))
                    : h('div', { style: styles.list }, managedSkills.map(row)),
                  builtinSkills.length === 0
                    ? null
                    : h('div', { style: styles.group },
                      h('button', {
                        type: 'button',
                        style: styles.groupHeader,
                        'aria-expanded': builtinVisible,
                        onClick: () => { setBuiltinOpen(value => !value) },
                      },
                      h('span', null, `${t('builtinGroup')} (${String(builtinSkills.length)})`),
                      h('span', { style: styles.groupHeaderRight },
                        h('span', null, t('builtinGroupMeta')),
                        h('span', null, builtinVisible ? '▾' : '▸'))),
                      builtinVisible
                        ? h('div', { style: styles.list }, builtinSkills.map(row))
                        : null)),
          h('div', { style: styles.panel },
            h('button', {
              type: 'button',
              style: styles.panelHeader,
              'aria-expanded': settingsOpen,
              onClick: () => { setSettingsOpen(value => !value) },
            },
            h('span', null, t('settings')),
            h('span', { style: styles.groupHeaderRight }, settingsOpen ? '▾' : '▸')),
            settingsOpen
              ? h('div', { style: styles.panelBody },
                h('p', { style: styles.hint }, t('policyLabel')),
                h('div', { style: styles.radioGroup },
                  h('button', { type: 'button', style: styles.filterButton(snapshot.settings.disabledSkillPolicy === 'ask'), onClick: () => { updatePolicy('ask') } }, t('policyAsk')),
                  h('button', { type: 'button', style: styles.filterButton(snapshot.settings.disabledSkillPolicy === 'deny'), onClick: () => { updatePolicy('deny') } }, t('policyDeny')),
                  h('button', { type: 'button', style: styles.filterButton(snapshot.settings.disabledSkillPolicy === 'allow'), onClick: () => { updatePolicy('allow') } }, t('policyAllow'))),
                h('p', { style: styles.hint }, t('policyHint')),
                h('div', { style: styles.settingRow },
                  h('span', null, t('backupLabel')),
                  h(Toggle, {
                    checked: snapshot.settings.backupOnUninstall === true,
                    busy: busy === 'updateSettings',
                    label: t('backupLabel'),
                    onChange: toggleBackup,
                  })),
                h('p', { style: styles.hint }, t('backupHint')),
                h('button', {
                  type: 'button',
                  style: styles.tinyButton,
                  disabled: busy === 'clearStats',
                  onClick: () => { void run({ action: 'clearStats' }) },
                }, t('clearStats')))
              : null),
          h('div', { style: styles.panel },
            h('button', {
              type: 'button',
              style: styles.panelHeader,
              'aria-expanded': trashOpen,
              onClick: () => { setTrashOpen(value => !value) },
            },
            h('span', null, `${t('trash')} (${String(snapshot.trash.length)})`),
            h('span', { style: styles.groupHeaderRight }, trashOpen ? '▾' : '▸')),
            trashOpen
              ? h('div', { style: styles.panelBody },
                snapshot.trash.length === 0
                  ? h('p', { style: styles.hint }, t('trashEmpty'))
                  : h('div', { style: styles.list },
                    snapshot.trash.map(record => h('div', { key: record.id, style: styles.trashRow },
                      h('div', { style: styles.trashMeta },
                        h('span', null, record.name),
                        h('span', { style: styles.hint }, `${t('removedAt')(formatWhen(record.removedAt))} · ${t('entries')(record.entries)}${record.totalBytes > 0 ? ` · ${(record.totalBytes / 1024).toFixed(1)} KB` : ''}`)),
                      h('div', { style: styles.trashActions },
                        h('button', {
                          type: 'button',
                          style: styles.tinyButton,
                          disabled: busy === 'restoreTrash',
                          onClick: () => { void run({ action: 'restoreTrash', id: record.id }) },
                        }, t('restore')),
                        h('button', {
                          type: 'button',
                          style: styles.dangerButton,
                          disabled: busy === 'restoreTrash',
                          onClick: () => { void run({ action: 'emptyTrash' }) },
                        }, t('deleteForever'))))),
                    h('button', {
                      type: 'button',
                      style: confirmEmptyTrash ? styles.dangerButton : styles.tinyButton,
                      onClick: () => {
                        if (confirmEmptyTrash) {
                          void run({ action: 'emptyTrash' })
                          setConfirmEmptyTrash(false)
                        } else {
                          setConfirmEmptyTrash(true)
                        }
                      },
                    }, confirmEmptyTrash ? t('confirmEmptyTrash') : t('emptyTrash'))))
              : null),
          h('p', { style: styles.footer }, t('footer')),
          snapshot.statePath !== ''
            ? h('p', { style: styles.footer }, `${t('stateFile')}: ${snapshot.statePath}`)
            : null))
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'skillswitch: dictionaries')
        const t = ctx.locale.bind(NS)
        const openPlugins = () => {
          try {
            ctx.layout.selectPanel('plugins')
          } catch {
            // panel navigation is best effort only
          }
        }
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ t, openPlugins }),
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

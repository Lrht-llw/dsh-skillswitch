/**
 * Skill registry operations for Skillswitch.
 *
 * Owns the shadow provider that hides disabled skills from every consumer of
 * `ctx.skills`, plus listing, enabling/disabling, previewing and usage stats.
 * `state`, `persist`, `refreshCatalog`, and the skills registry are injected so
 * this module stays independent of the Cordis context.
 */

import { existsSync, readFileSync } from 'node:fs'

import { SKILL_NAME, isRemovablePath, normalizeDescription } from './state.js'

export const SHADOW_PROVIDER = 'skillswitch'
export const SHADOW_RANK = -1

const MAX_PREVIEW_BYTES = 200 * 1024

export function createSkills({ state, logger, persist, refreshCatalog, skills, onInvalidate, getState }) {
  /** The state every live provider should consult (shared across plugin reloads). */
  const currentState = typeof getState === 'function' ? getState : () => state

  function shadowCandidate(entryName) {
    const snapshot = currentState().disabled[entryName]
    if (snapshot === undefined) return undefined
    const description = snapshot.description.length > 0 ? snapshot.description : `已关闭的技能：${entryName}`
    return {
      name: entryName,
      description,
      source: snapshot.source || 'runtime',
      provider: SHADOW_PROVIDER,
      rank: SHADOW_RANK,
      invocation: { modelInvocable: false, userInvocable: false },
      locator: { disabled: entryName },
    }
  }

  function createShadowProvider() {
    return (control) => {
      if (typeof onInvalidate === 'function') onInvalidate(control.invalidate)
      return {
        name: SHADOW_PROVIDER,
        async list() {
          return Object.keys(currentState().disabled)
            .map(shadowCandidate)
            .filter(candidate => candidate !== undefined)
        },
        async get(candidate) {
          const snapshot = currentState().disabled[candidate.name]
          if (snapshot === undefined) return undefined
          return {
            name: candidate.name,
            description: snapshot.description.length > 0 ? snapshot.description : `已关闭的技能：${candidate.name}`,
            source: snapshot.source || 'runtime',
            provider: SHADOW_PROVIDER,
            invocation: { modelInvocable: false, userInvocable: false },
            content: '',
          }
        },
      }
    }
  }

  function statsFor(entryName) {
    const record = state.stats[entryName]
    if (record === undefined) return { loads: 0, lastUsedAt: 0 }
    return { loads: record.loads, lastUsedAt: record.lastUsedAt }
  }

  async function findSkill(entryName, options) {
    try {
      const summaries = await skills.list({ cwd: options.cwd, scope: options.scope })
      return summaries.find(summary => summary.name === entryName
        && (summary.provider !== SHADOW_PROVIDER || currentState().disabled[entryName] === undefined))
    } catch (error) {
      logger.warn(`skillswitch: cannot list skills: ${String(error)}`)
      return undefined
    }
  }

  async function listSkills(options) {
    const entries = new Map()
    let summaries = []
    try {
      summaries = await skills.list({ cwd: options.cwd, scope: options.scope })
    } catch (error) {
      logger.warn(`skillswitch: cannot list skills: ${String(error)}`)
    }
    for (const summary of summaries) {
      // A shadow candidate whose name is no longer disabled comes from a stale
      // provider left behind by an earlier plugin instance; show it as the real
      // skill instead of hiding it.
      if (summary.provider === SHADOW_PROVIDER && currentState().disabled[summary.name] !== undefined) continue
      entries.set(summary.name, {
        name: summary.name,
        description: normalizeDescription(summary.description),
        source: typeof summary.source === 'string' ? summary.source : 'runtime',
        provider: typeof summary.provider === 'string' ? summary.provider : '',
        path: typeof summary.path === 'string' ? summary.path : '',
        disabled: state.disabled[summary.name] !== undefined,
        removable: isRemovablePath(summary.path, options.cwd),
        modelInvocable: summary.invocation?.modelInvocable !== false,
        userInvocable: summary.invocation?.userInvocable !== false,
        ...statsFor(summary.name),
      })
    }
    for (const [entryName, snapshot] of Object.entries(state.disabled)) {
      const existing = entries.get(entryName)
      if (existing !== undefined) {
        existing.disabled = true
        continue
      }
      entries.set(entryName, {
        name: entryName,
        description: normalizeDescription(snapshot.description),
        source: snapshot.source || 'runtime',
        provider: snapshot.provider || '',
        path: snapshot.path || '',
        disabled: true,
        removable: isRemovablePath(snapshot.path, options.cwd),
        modelInvocable: false,
        userInvocable: false,
        ...statsFor(entryName),
      })
    }
    return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  async function setEnabled(entryName, enabled, options, actor) {
    if (typeof entryName !== 'string' || !SKILL_NAME.test(entryName)) {
      return { ok: false, message: `技能名不合法：${String(entryName)}` }
    }
    const isDisabled = state.disabled[entryName] !== undefined
    if (enabled) {
      if (!isDisabled) return { ok: true, message: `skill「${entryName}」本来就是开启状态。` }
      if (actor === 'model' && state.settings.disabledSkillPolicy === 'deny') {
        return {
          ok: false,
          message: `当前策略不允许模型自行开启技能。请让用户在「技能」页面手动开启「${entryName}」。`,
        }
      }
      delete state.disabled[entryName]
      persist()
      refreshCatalog()
      return { ok: true, message: `已开启 skill「${entryName}」，下一次模型请求起可用。` }
    }
    if (isDisabled) return { ok: true, message: `skill「${entryName}」本来就是关闭状态。` }
    const found = await findSkill(entryName, options)
    state.disabled[entryName] = {
      description: found !== undefined ? normalizeDescription(found.description) : '',
      source: found?.source ?? 'runtime',
      provider: found?.provider === SHADOW_PROVIDER ? '' : (found?.provider ?? ''),
      path: typeof found?.path === 'string' ? found.path : '',
      since: Date.now(),
    }
    persist()
    refreshCatalog()
    return {
      ok: true,
      message: found === undefined
        ? `已关闭 skill「${entryName}」。当前视角没有找到它的定义；如果它属于其他会话的技能根，请在那个会话里再确认。`
        : `已关闭 skill「${entryName}」，它已从技能目录与 skill 工具中移除。`,
    }
  }

  async function readSkill(entryName, options) {
    if (typeof entryName !== 'string' || !SKILL_NAME.test(entryName)) {
      return { ok: false, message: `技能名不合法：${String(entryName)}` }
    }
    const disabledSnapshot = state.disabled[entryName]
    const summary = disabledSnapshot === undefined ? await findSkill(entryName, options) : undefined
    let path = typeof summary?.path === 'string' ? summary.path : (disabledSnapshot?.path ?? '')
    let content = ''
    let description = summary !== undefined ? normalizeDescription(summary.description) : normalizeDescription(disabledSnapshot?.description ?? '')
    let source = summary?.source ?? disabledSnapshot?.source ?? 'runtime'
    let provider = summary?.provider ?? disabledSnapshot?.provider ?? ''
    if (disabledSnapshot !== undefined) {
      if (path !== '' && existsSync(path)) {
        try {
          content = readFileSync(path, 'utf8')
        } catch (error) {
          return { ok: false, message: `读取失败：${String(error)}` }
        }
      }
    } else {
      try {
        const definition = await skills.get(entryName, { cwd: options.cwd, scope: options.scope })
        if (definition !== undefined) {
          content = typeof definition.content === 'string' ? definition.content : ''
          if (typeof definition.path === 'string') path = definition.path
          description = normalizeDescription(definition.description)
          source = definition.source
          provider = definition.provider
        }
      } catch (error) {
        return { ok: false, message: `读取失败：${String(error)}` }
      }
    }
    if (typeof content !== 'string') content = ''
    let truncated = false
    if (content.length > MAX_PREVIEW_BYTES) {
      content = content.slice(0, MAX_PREVIEW_BYTES)
      truncated = true
    }
    return { ok: true, name: entryName, path, description, source, provider, content, truncated }
  }

  /** Record one successful `skill` load for the usage counters. */
  function recordLoad(entryName) {
    const current = statsFor(entryName)
    state.stats[entryName] = { loads: current.loads + 1, lastUsedAt: Date.now() }
    persist()
  }

  return {
    shadowCandidate,
    createShadowProvider,
    statsFor,
    findSkill,
    listSkills,
    setEnabled,
    readSkill,
    recordLoad,
  }
}

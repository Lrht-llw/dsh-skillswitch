/**
 * Skillswitch — manage installed skills from the sidebar: list them, switch
 * them on or off, uninstall user-installed files, preview bodies, inspect
 * usage, move skills through an optional trash, export/import skill packs, and
 * check for plugin updates.
 *
 * This module is the thin Cordis entry point. The work lives in:
 * - `skills.js`  — shadow provider, listing, enable/disable, preview, stats;
 * - `trash.js`   — uninstall, recycle bin, restore;
 * - `packs.js`   — JSON skill-pack export/import;
 * - `policy.js`  — `tools/pre-execute` decisions;
 * - `manage-tool.js` — the model-facing `skill_manage` tool;
 * - `api.js`     — authenticated HTTP dispatch;
 * - `update.js`  — npm version check;
 * - `state.js`   — persistent state, paths and filesystem helpers.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { API_PATH, createApi, registerHttpRoute } from './api.js'
import { createManageTool } from './manage-tool.js'
import { createPacks } from './packs.js'
import { TOOL_NAME, decidePreTool } from './policy.js'
import { createSkills } from './skills.js'
import { createTrash } from './trash.js'
import {
  DEFAULT_SETTINGS,
  DISABLED_POLICIES,
  SKILL_NAME,
  readState,
  stateFilePath,
  writeState,
} from './state.js'
import { checkUpdate, readOwnVersion } from './update.js'

export const name = 'skillswitch'
export const inject = ['skills', 'tools', 'agents']

/**
 * Process-wide state shared by every Skillswitch instance. A previous instance's
 * shadow provider can outlive a reload in an agent scope; pointing all providers
 * at the newest state keeps a stale provider from hiding a skill that is enabled.
 */
const SHARED_STATE_KEY = Symbol.for('dsh-skillswitch.shared-state')

export function apply(ctx) {
  const logger = ctx.logger ?? { info() {}, warn() {} }
  const state = readState(logger)
  globalThis[SHARED_STATE_KEY] = state
  const invalidators = new Set()
  const agentMounts = new Map()

  if (!Array.isArray(state.trash)) state.trash = []
  if (state.stats === null || typeof state.stats !== 'object') state.stats = {}
  if (state.settings === null || typeof state.settings !== 'object') state.settings = { ...DEFAULT_SETTINGS }

  function persist() {
    if (disposed === true) return
    writeState(state, logger)
  }
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
  }, 'skillswitch: mark disposed')

  /** Ask the registry to rediscover, which rebuilds every consumer's catalog. */
  function refreshCatalog() {
    for (const invalidate of invalidators) {
      try {
        invalidate()
      } catch (error) {
        logger.warn(`skillswitch: catalog invalidation failed: ${String(error)}`)
      }
    }
  }

  const skills = createSkills({
    state,
    logger,
    persist,
    refreshCatalog,
    skills: ctx.skills,
    onInvalidate: (invalidate) => { invalidators.add(invalidate) },
    getState: () => globalThis[SHARED_STATE_KEY] ?? state,
  })
  const trash = createTrash({
    state,
    logger,
    persist,
    refreshCatalog,
    findSkill: skills.findSkill,
  })
  trash.flushPending()
  const packs = createPacks({
    findSkill: skills.findSkill,
    refreshCatalog,
    logger,
  })
  const pluginManager = ctx.get('pluginManager')

  /** Report each tool dependency's install and connection state. */
  async function dependencyStatus(bundles, plugins) {
    let toolNames = []
    try {
      toolNames = (ctx.tools.schemas?.() ?? []).map(schema => schema.name)
    } catch (error) {
      logger.warn(`skillswitch: cannot read tool schemas: ${String(error)}`)
    }
    let bundleInfos = []
    if (pluginManager !== undefined && typeof pluginManager.listBundles === 'function') {
      try {
        bundleInfos = await pluginManager.listBundles()
      } catch (error) {
        logger.warn(`skillswitch: cannot list installed bundles: ${String(error)}`)
      }
    }
    const isInstalled = name => bundleInfos.some(info => info.name === name && info.installed !== false)
    const mcp = (Array.isArray(bundles) ? bundles : []).map((bundle) => {
      const serverName = typeof bundle?.mcp?.serverName === 'string' ? bundle.mcp.serverName : ''
      const prefix = serverName === '' ? '' : `mcp__${serverName}__`
      const bundleName = typeof bundle?.name === 'string' ? bundle.name : ''
      return {
        name: bundleName,
        serverName,
        transport: typeof bundle?.mcp?.transport === 'string' ? bundle.mcp.transport : '',
        credentials: Array.isArray(bundle?.credentials) ? bundle.credentials : [],
        installed: isInstalled(`@local/${bundleName}`),
        satisfied: prefix !== '' && toolNames.some(name => name.startsWith(prefix)),
      }
    })
    const pluginRows = (Array.isArray(plugins) ? plugins : []).map(name => ({
      name,
      satisfied: isInstalled(name),
    }))
    return { mcp, plugins: pluginRows }
  }

  async function importPackWithStatus(rawPack) {
    const result = await packs.importPack(rawPack)
    if (result.ok !== true) return result
    return {
      ...result,
      dependencies: await dependencyStatus(result.bundles, result.plugins),
    }
  }

  /** Compact, user-facing detail for a failed plugin-manager change. */
  function dependencyFailureDetail(result) {
    const pieces = []
    const diagnostic = result?.error?.diagnostic
    if (typeof diagnostic === 'string' && diagnostic.length > 0) pieces.push(diagnostic)
    const output = result?.packageResult?.output
    if (typeof output === 'string' && output.trim() !== '') {
      const tail = output.trim().split('\n').filter(line => line.trim() !== '').slice(-4).join(' | ')
      if (tail !== '') pieces.push(tail)
    }
    if (typeof result?.error?.code === 'string' && result.error.code !== '') pieces.push(`code: ${result.error.code}`)
    const text = pieces.join(' — ')
    return text.length > 600 ? `${text.slice(0, 600)}…` : text
  }

  /** Install one generated MCP bundle or one plugin requirement through pluginManager. */
  async function installDependency(payload) {
    const request = payload !== null && typeof payload === 'object' ? payload : {}
    const kind = typeof request.kind === 'string' ? request.kind : ''
    const name = typeof request.name === 'string' ? request.name : ''
    if (name === '') return { ok: false, message: '缺少依赖名称。' }
    if (pluginManager === undefined || typeof pluginManager.installBundle !== 'function') {
      return { ok: false, message: '当前 DSH 环境不支持自动安装插件依赖，请手动安装。', spec: name }
    }
    let spec = name
    if (kind === 'bundle') {
      if (!/^[a-z0-9][a-z0-9._-]{0,80}$/iu.test(name)) {
        return { ok: false, message: `依赖 bundle 名称不合法：${name}` }
      }
      spec = join(packs.dependencyDirectory(), name)
      if (!existsSync(spec)) return { ok: false, message: `依赖 bundle 不存在：${spec}` }
    } else if (kind !== 'plugin') {
      return { ok: false, message: `未知依赖类型：${kind || '(空)'}` }
    }
    try {
      const result = await pluginManager.installBundle(spec, { enabled: true })
      const application = typeof result?.application === 'string' ? result.application : 'unknown'
      const failed = application === 'failed'
      return {
        ok: failed !== true,
        message: failed === true
          ? `安装依赖失败：${dependencyFailureDetail(result) || application}`
          : application === 'applied'
            ? '依赖已安装并生效。'
            : '依赖已安装；可能需要重启 DSH 后完全生效。',
        application,
        result,
      }
    } catch (error) {
      return { ok: false, message: `安装依赖失败：${String(error)}` }
    }
  }

  /** Remove one installed dependency bundle or plugin requirement through pluginManager. */
  async function removeDependency(payload) {
    const request = payload !== null && typeof payload === 'object' ? payload : {}
    const kind = typeof request.kind === 'string' ? request.kind : ''
    const name = typeof request.name === 'string' ? request.name : ''
    if (name === '') return { ok: false, message: '缺少依赖名称。' }
    if (kind !== 'bundle' && kind !== 'plugin') {
      return { ok: false, message: `未知依赖类型：${kind || '(空)'}` }
    }
    if (pluginManager === undefined || typeof pluginManager.removeBundle !== 'function') {
      return { ok: false, message: '当前 DSH 环境不支持自动卸载插件依赖，请手动卸载。', spec: name }
    }
    if (kind === 'bundle' && !/^[a-z0-9][a-z0-9._-]{0,80}$/iu.test(name)) {
      return { ok: false, message: `依赖 bundle 名称不合法：${name}` }
    }
    const spec = kind === 'bundle' ? `@local/${name}` : name
    try {
      const result = await pluginManager.removeBundle(spec)
      const application = typeof result?.application === 'string' ? result.application : 'unknown'
      const failed = application === 'failed'
      const notRemovable = result?.error?.code === 'not-removable'
      const changed = result?.changed !== false && failed !== true && notRemovable !== true
      return {
        ok: changed,
        message: notRemovable
          ? '依赖未安装，无需卸载。'
          : failed === true
            ? `卸载依赖失败：${dependencyFailureDetail(result) || application}`
            : changed ? '依赖已卸载。' : '依赖未安装，无需卸载。',
        application,
        result,
      }
    } catch (error) {
      return { ok: false, message: `卸载依赖失败：${String(error)}` }
    }
  }

  async function contextFor(agent, signal) {
    const workingDirectory = ctx.get('workingDirectory')
    let cwd
    if (agent !== undefined && workingDirectory !== undefined) {
      try {
        cwd = await workingDirectory.ensure(agent, signal)
      } catch {
        cwd = undefined
      }
    }
    if (typeof cwd !== 'string' || cwd.length === 0) {
      cwd = workingDirectory?.defaultDirectory ?? process.cwd()
    }
    return { cwd, scope: agent }
  }

  function pickAgent() {
    const agents = ctx.agents.list()
    return agents.length > 0 ? agents[agents.length - 1] : undefined
  }

  function currentView(agent, options) {
    return {
      mode: agent === undefined ? 'global' : 'session',
      agent: agent === undefined ? '' : String(agent.id),
      cwd: typeof options.cwd === 'string' ? options.cwd : '',
    }
  }

  function settingsView() {
    return {
      disabledSkillPolicy: state.settings.disabledSkillPolicy,
      backupOnUninstall: state.settings.backupOnUninstall,
    }
  }

  function updateSettings(patch) {
    const next = patch !== null && typeof patch === 'object' ? patch : {}
    const changes = []
    if (typeof next.disabledSkillPolicy === 'string') {
      if (!DISABLED_POLICIES.includes(next.disabledSkillPolicy)) {
        return { ok: false, message: `不支持的策略：${next.disabledSkillPolicy}` }
      }
      state.settings.disabledSkillPolicy = next.disabledSkillPolicy
      changes.push('策略')
    }
    if (typeof next.backupOnUninstall === 'boolean') {
      state.settings.backupOnUninstall = next.backupOnUninstall
      changes.push('备份')
    }
    if (changes.length === 0) return { ok: false, message: '没有可更新的设置。' }
    persist()
    return { ok: true, message: `已更新设置：${settingsView().disabledSkillPolicy} / 备份${settingsView().backupOnUninstall ? '开' : '关'}。`, settings: settingsView() }
  }

  function clearStats() {
    state.stats = {}
    persist()
    return { ok: true, message: '使用统计已清除。' }
  }

  // Global layer: shadows every provider registered by the profile itself.
  ctx.effect(() => ctx.skills.registerProvider(skills.createShadowProvider()), 'skillswitch: global shadow provider')

  // Agent scope: the nearest layer, so a preset-scoped provider cannot win.
  function mountAgent(agent) {
    if (agent === undefined || agentMounts.has(agent)) return
    const agentCtx = agent.ctx
    const agentSkills = agentCtx?.get?.('skills')
    if (agentCtx === undefined || agentSkills === undefined) return
    try {
      const dispose = agentCtx.effect(
        () => agentSkills.registerProvider(skills.createShadowProvider()),
        'skillswitch: agent shadow provider',
      )
      agentMounts.set(agent, dispose)
    } catch (error) {
      logger.warn(`skillswitch: cannot mount per-agent shadow provider: ${String(error)}`)
    }
  }

  for (const agent of ctx.agents.list()) mountAgent(agent)
  ctx.on('agent/created', ({ agent }) => { mountAgent(agent) })
  ctx.on('agent/disposed', ({ agent }) => { agentMounts.delete(agent) })
  ctx.effect(() => () => {
    for (const dispose of agentMounts.values()) {
      try {
        dispose()
      } catch (error) {
        logger.warn(`skillswitch: cannot unmount agent shadow provider: ${String(error)}`)
      }
    }
    agentMounts.clear()
  }, 'skillswitch: dispose agent mounts')

  const approvalService = ctx.get('approval')

  /** Effective approval policy for one agent: session override, then configured default. */
  function effectiveApprovalPolicy(agent) {
    try {
      const override = approvalService !== undefined && typeof approvalService.overrideOf === 'function'
        ? approvalService.overrideOf(agent?.session)
        : undefined
      if (override === 'ask' || override === 'never') return override
      const configured = approvalService?.config?.policy
      if (configured === 'ask' || configured === 'never') return configured
      return undefined
    } catch (error) {
      logger.warn(`skillswitch: cannot read approval policy: ${String(error)}`)
      return undefined
    }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = decidePreTool(exec, {
      policy: state.settings.disabledSkillPolicy,
      disabled: state.disabled,
      toolName: TOOL_NAME,
      approvalDisabled: effectiveApprovalPolicy(exec.agent) === 'never',
    })
    if (decision === undefined) return next()
    return decision
  })

  ctx.on('tools/result', (exec, result) => {
    if (exec?.name !== 'skill') return
    if (result?.isError === true) return
    const argumentsValue = exec.arguments
    const requested = argumentsValue !== null && typeof argumentsValue === 'object'
      ? argumentsValue.name
      : undefined
    if (typeof requested !== 'string' || !SKILL_NAME.test(requested)) return
    skills.recordLoad(requested)
  })

  const manageTool = createManageTool({
    contextFor,
    listSkills: skills.listSkills,
    readSkill: skills.readSkill,
    setEnabled: skills.setEnabled,
    uninstall: trash.uninstall,
    getPolicy: () => state.settings.disabledSkillPolicy,
  })
  ctx.effect(() => ctx.tools.register(manageTool), 'skillswitch: skill_manage tool')

  const api = createApi({
    contextFor,
    pickAgent,
    currentView,
    settingsView,
    listSkills: skills.listSkills,
    setEnabled: skills.setEnabled,
    uninstall: trash.uninstall,
    readSkill: skills.readSkill,
    exportSkill: packs.exportSkill,
    exportSkills: packs.exportSkills,
    importPack: importPackWithStatus,
    installDependency,
    removeDependency,
    dependencyStatus,
    listTrash: trash.listTrash,
    restoreTrash: trash.restoreTrash,
    emptyTrash: trash.emptyTrash,
    updateSettings,
    clearStats,
    checkUpdate,
    readOwnVersion,
    stateFilePath,
    logger,
  })
  registerHttpRoute(ctx, { apiPath: API_PATH, dispatch: api.dispatch, logger })

  // Rebuild the catalog once after activation so a provider left behind by a
  // previous reload cannot keep serving an older view of the disabled set.
  setTimeout(() => {
    try {
      refreshCatalog()
    } catch (error) {
      logger.warn(`skillswitch: initial catalog refresh failed: ${String(error)}`)
    }
  }, 0)
}

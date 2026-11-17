/**
 * Skillswitch — list installed skills, switch them on or off, and uninstall
 * user-installed skill files.
 *
 * Host half:
 * - a shadow skill provider (`rank: -1`, both invocation flags false) makes every
 *   disabled skill invisible to every consumer of `ctx.skills`: the durable
 *   session catalog, the `skill` tool, and `/name` gestures;
 * - a `tools/pre-execute` gate answers a call to a disabled skill with the local
 *   "该 skill 已被关闭" reason instead of the generic "not available" text;
 * - one `skill_manage` tool and one authenticated HTTP route
 *   (`/api/skillswitch`) share the same operations for the model and the page;
 * - `$DSH_HOME/skillswitch/state.json` persists the switches.
 *
 * The shadow provider is registered once in the global layer and once per live
 * agent scope, so a packaged or preset-scoped skill cannot outrank it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

export const name = 'skillswitch'
export const inject = ['skills', 'tools', 'agents']

const SHADOW_PROVIDER = 'skillswitch'
const SHADOW_RANK = -1
const TOOL_NAME = 'skill_manage'
const API_PATH = '/api/skillswitch'
const PACKAGE_NAME = 'dsh-skillswitch'
const STATE_VERSION = 1
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function agentsHome() {
  return process.env.DSH_AGENTS_HOME || join(homedir(), '.agents')
}

function stateFilePath() {
  return join(dshHome(), 'skillswitch', 'state.json')
}

function normalizePath(value) {
  const absolute = resolve(value)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function isInside(root, target) {
  const normalizedRoot = normalizePath(root)
  const normalizedTarget = normalizePath(target)
  return normalizedTarget === normalizedRoot
    || normalizedTarget.startsWith(normalizedRoot + sep)
}

function normalizeDescription(value) {
  if (typeof value !== 'string') return ''
  return value.replaceAll(/\s+/gu, ' ').trim()
}

function readState(logger) {
  const file = stateFilePath()
  const empty = { version: STATE_VERSION, disabled: {} }
  try {
    if (!existsSync(file)) return empty
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const raw = parsed !== null && typeof parsed === 'object' && parsed.disabled !== null
      && typeof parsed.disabled === 'object' ? parsed.disabled : {}
    const disabled = {}
    for (const [key, value] of Object.entries(raw)) {
      if (!SKILL_NAME.test(key)) continue
      const snapshot = value !== null && typeof value === 'object' ? value : {}
      disabled[key] = {
        description: typeof snapshot.description === 'string' ? snapshot.description : '',
        source: typeof snapshot.source === 'string' ? snapshot.source : 'runtime',
        provider: typeof snapshot.provider === 'string' ? snapshot.provider : '',
        path: typeof snapshot.path === 'string' ? snapshot.path : '',
        since: typeof snapshot.since === 'number' ? snapshot.since : 0,
      }
    }
    return { version: STATE_VERSION, disabled }
  } catch (error) {
    logger.warn(`skillswitch: cannot read ${file}: ${String(error)}`)
    return empty
  }
}

function writeState(state, logger) {
  const file = stateFilePath()
  const directory = dirname(file)
  const temporary = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    logger.warn(`skillswitch: cannot write ${file}: ${String(error)}`)
    try {
      rmSync(temporary, { force: true })
    } catch {
      // best effort cleanup only
    }
  }
}

/**
 * Skill roots this machine may write: user, shared-agent, and the active
 * project roots. A skill file anywhere else (application archive, install
 * directory) is switchable but not uninstallable.
 */
function writableRoots(cwd) {
  const roots = [join(dshHome(), 'skills'), join(agentsHome(), 'skills')]
  if (typeof cwd === 'string' && cwd.length > 0) {
    roots.push(join(cwd, '.dsh', 'skills'), join(cwd, '.agents', 'skills'))
  }
  return [...new Set(roots.map(root => resolve(root)))]
}

/** Deletable skill entry (a bundle directory or a flat `.md` file) or undefined. */
function deletableEntry(candidatePath, roots) {
  if (typeof candidatePath !== 'string' || candidatePath.length === 0) return undefined
  const absolute = resolve(candidatePath)
  const target = absolute.toLowerCase().endsWith(`${sep}skill.md`) ? dirname(absolute) : absolute
  const parent = dirname(target)
  return roots.some(root => normalizePath(root) === normalizePath(parent)) ? target : undefined
}

function isRemovablePath(candidatePath, cwd) {
  return deletableEntry(candidatePath, writableRoots(cwd)) !== undefined
}

/** Version of the running package, read from the manifest beside this module. */
function readOwnVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : ''
  } catch {
    return ''
  }
}

/** Parse a semver core and pre-release tag into comparable parts. */
function parseVersion(value) {
  const text = String(value).trim().replace(/^v/u, '')
  const dash = text.indexOf('-')
  const core = dash === -1 ? text : text.slice(0, dash)
  const pre = dash === -1 ? '' : text.slice(dash + 1)
  const numbers = core.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10)
    return Number.isFinite(parsed) ? parsed : 0
  })
  return { numbers, pre }
}

/** Negative, zero, or positive as `left` sorts before, equal to, or after `right`. */
function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0)
    if (difference !== 0) return difference
  }
  if (a.pre === b.pre) return 0
  if (a.pre === '') return 1
  if (b.pre === '') return -1
  return a.pre < b.pre ? -1 : 1
}

const UPDATE_SOURCES = [
  `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
  `https://registry.npmmirror.com/${PACKAGE_NAME}/latest`,
]

/** Compare the running version with the newest published npm version. */
async function checkUpdate(logger) {
  const current = readOwnVersion()
  if (typeof fetch !== 'function') {
    return { ok: false, message: '当前运行环境不支持网络请求', current }
  }
  let lastError
  for (const source of UPDATE_SOURCES) {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(new Error('timeout')) }, 8000)
    try {
      const response = await fetch(source, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const metadata = await response.json()
      const latest = metadata !== null && typeof metadata === 'object' && typeof metadata.version === 'string'
        ? metadata.version
        : ''
      if (latest === '') throw new Error('响应缺少 version 字段')
      return {
        ok: true,
        current,
        latest,
        updateAvailable: compareVersions(latest, current) > 0,
        registry: new URL(source).host,
        packageUrl: `https://www.npmjs.com/package/${PACKAGE_NAME}`,
        checkedAt: new Date().toISOString(),
      }
    } catch (error) {
      lastError = error
      logger.warn(`skillswitch: update check failed on ${source}: ${String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, message: `检查更新失败：${String(lastError?.message ?? lastError)}`, current }
}

export function apply(ctx) {
  const logger = ctx.logger ?? { info() {}, warn() {} }
  const state = readState(logger)
  const invalidators = new Set()
  const agentMounts = new Map()

  function persist() {
    writeState(state, logger)
  }

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

  function shadowCandidate(entryName) {
    const snapshot = state.disabled[entryName]
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
      invalidators.add(control.invalidate)
      return {
        name: SHADOW_PROVIDER,
        async list() {
          return Object.keys(state.disabled)
            .map(shadowCandidate)
            .filter(candidate => candidate !== undefined)
        },
        async get(candidate) {
          const snapshot = state.disabled[candidate.name]
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

  // Global layer: shadows every provider registered by the profile itself.
  ctx.effect(() => ctx.skills.registerProvider(createShadowProvider()), 'skillswitch: global shadow provider')

  // Agent scope: the nearest layer, so a preset-scoped provider cannot win.
  function mountAgent(agent) {
    if (agent === undefined || agentMounts.has(agent)) return
    try {
      const dispose = agent.ctx.inject(['skills'], (agentCtx) => agentCtx.effect(
        () => agentCtx.skills.registerProvider(createShadowProvider()),
        'skillswitch: agent shadow provider',
      ))
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

  async function findSkill(entryName, options) {
    try {
      const summaries = await ctx.skills.list({ cwd: options.cwd, scope: options.scope })
      return summaries.find(summary => summary.name === entryName && summary.provider !== SHADOW_PROVIDER)
    } catch (error) {
      logger.warn(`skillswitch: cannot list skills: ${String(error)}`)
      return undefined
    }
  }

  async function listSkills(options) {
    const entries = new Map()
    let summaries = []
    try {
      summaries = await ctx.skills.list({ cwd: options.cwd, scope: options.scope })
    } catch (error) {
      logger.warn(`skillswitch: cannot list skills: ${String(error)}`)
    }
    for (const summary of summaries) {
      if (summary.provider === SHADOW_PROVIDER) continue
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
      })
    }
    return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  async function setEnabled(entryName, enabled, options) {
    if (typeof entryName !== 'string' || !SKILL_NAME.test(entryName)) {
      return { ok: false, message: `技能名不合法：${String(entryName)}` }
    }
    const isDisabled = state.disabled[entryName] !== undefined
    if (enabled) {
      if (!isDisabled) return { ok: true, message: `skill「${entryName}」本来就是开启状态。` }
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
      provider: found?.provider ?? '',
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

  async function uninstall(entryName, options) {
    if (typeof entryName !== 'string' || !SKILL_NAME.test(entryName)) {
      return { ok: false, message: `技能名不合法：${String(entryName)}` }
    }
    const roots = writableRoots(options.cwd)
    const candidates = new Set()
    const found = await findSkill(entryName, options)
    if (found !== undefined && typeof found.path === 'string') candidates.add(found.path)
    const snapshot = state.disabled[entryName]
    if (snapshot !== undefined && snapshot.path.length > 0) candidates.add(snapshot.path)
    for (const root of roots) {
      candidates.add(join(root, entryName))
      candidates.add(join(root, `${entryName}.md`))
    }
    const removed = []
    for (const candidate of candidates) {
      const target = deletableEntry(candidate, roots)
      if (target === undefined || !existsSync(target)) continue
      try {
        rmSync(target, { recursive: true, force: true })
        removed.push(target)
      } catch (error) {
        return { ok: false, message: `删除失败：${target}：${String(error)}` }
      }
    }
    if (removed.length === 0) {
      return {
        ok: false,
        message: `没有找到可卸载的 skill 文件。「${entryName}」可能是内置或打包技能，只能关闭（disable），不能卸载。`,
      }
    }
    let stateChanged = false
    if (state.disabled[entryName] !== undefined) {
      delete state.disabled[entryName]
      stateChanged = true
    }
    if (stateChanged) persist()
    refreshCatalog()
    return {
      ok: true,
      message: `已卸载 skill「${entryName}」，删除了 ${String(removed.length)} 个路径：${removed.join('、')}`,
      removed,
    }
  }

  const listToolLines = skills => skills.map(skill => `- ${skill.name}：${skill.disabled ? '已关闭' : '已开启'}，来源 ${skill.source}${skill.removable ? '，可卸载' : '，仅可关闭'}`)

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec?.name !== 'skill') return next()
    const argumentsValue = exec.arguments
    const requested = argumentsValue !== null && typeof argumentsValue === 'object'
      ? argumentsValue.name
      : undefined
    if (typeof requested !== 'string' || state.disabled[requested] === undefined) return next()
    return {
      kind: 'deny',
      reason: [
        `该 skill「${requested}」已被关闭，当前不可加载。`,
        `如需使用：先征询用户是否开启；用户同意后调用 ${TOOL_NAME}(action="enable", name="${requested}") 开启，再正常调用 skill。`,
        '用户也可以在左侧边栏的「技能管理」页面手动开启。',
      ].join('\n'),
    }
  })

  const manageTool = {
    name: TOOL_NAME,
    description: [
      'Manage installed skills. list shows every skill with its on/off state and whether it can be uninstalled.',
      'disable hides a skill from the session skill catalog and blocks the skill tool until it is enabled again.',
      'uninstall permanently deletes a user-installed skill from disk; shipped or packaged skills can only be disabled.',
      'Enable a disabled skill only after the user agrees to it.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'enable', 'disable', 'uninstall'],
          description: 'Operation to run.',
        },
        name: {
          type: 'string',
          description: 'Exact kebab-case skill name; required for enable, disable, and uninstall.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          lines: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(_args, value) {
        const lines = Array.isArray(value?.lines) ? value.lines : []
        const text = lines.length > 0 ? lines.join('\n') : (typeof value?.message === 'string' ? value.message : '')
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      const options = await contextFor(exec.agent, exec.signal)
      const action = typeof args?.action === 'string' ? args.action : ''
      const entryName = typeof args?.name === 'string' ? args.name : ''
      if (action === 'list') {
        const skills = await listSkills(options)
        return {
          ok: true,
          lines: [
            `共 ${String(skills.length)} 个 skill（已开启 ${String(skills.filter(skill => !skill.disabled).length)}，已关闭 ${String(skills.filter(skill => skill.disabled).length)}）：`,
            ...listToolLines(skills),
          ],
        }
      }
      if (action === 'enable' || action === 'disable') {
        const result = await setEnabled(entryName, action === 'enable', options)
        return { ok: result.ok, message: result.message }
      }
      if (action === 'uninstall') {
        const result = await uninstall(entryName, options)
        return { ok: result.ok, message: result.message }
      }
      return { ok: false, message: `未知操作：${action || '(空)'}` }
    },
  }

  ctx.effect(() => ctx.tools.register(manageTool), 'skillswitch: skill_manage tool')

  async function dispatch(body) {
    const payload = body !== null && typeof body === 'object' ? body : {}
    const action = typeof payload.action === 'string' ? payload.action : ''
    const options = await contextFor(pickAgent(), undefined)
    if (action === 'list') {
      return {
        ok: true,
        skills: await listSkills(options),
        statePath: stateFilePath(),
        version: readOwnVersion(),
      }
    }
    if (action === 'setEnabled') {
      return setEnabled(typeof payload.name === 'string' ? payload.name : '', payload.enabled !== false, options)
    }
    if (action === 'uninstall') {
      return uninstall(typeof payload.name === 'string' ? payload.name : '', options)
    }
    if (action === 'checkUpdate') {
      return checkUpdate(logger)
    }
    return { ok: false, message: `未知操作：${action || '(空)'}` }
  }

  function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }

  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection
    if (connection === undefined || connection.fetch === undefined) return
    connectionCtx.effect(() => {
      const dispose = connection.fetch.register({
        path: API_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
          let body
          try {
            body = await request.json()
          } catch {
            return jsonResponse({ ok: false, message: '请求体不是合法 JSON' }, 400)
          }
          try {
            return jsonResponse(await dispatch(body))
          } catch (error) {
            logger.warn(`skillswitch: api request failed: ${String(error)}`)
            return jsonResponse({ ok: false, message: `内部错误：${String(error)}` }, 500)
          }
        },
      })
      return () => { void dispose() }
    }, 'skillswitch: api route')
  })
}

/**
 * Skillswitch — list installed skills, switch them on or off, uninstall
 * user-installed skill files, preview skill bodies, inspect usage, export and
 * import skill packs, and check for plugin updates.
 *
 * Host half:
 * - a shadow skill provider (`rank: -1`, both invocation flags false) makes every
 *   disabled skill invisible to every consumer of `ctx.skills`: the durable
 *   session catalog, the `skill` tool, and `/name` gestures;
 * - a `tools/pre-execute` gate answers a call to a disabled skill with a policy
 *   aware reason (ask the user / refuse model self-enable / allow self-enable);
 * - one `skill_manage` tool and one authenticated HTTP route
 *   (`/api/skillswitch`) share the same operations for the model and the page;
 * - `$DSH_HOME/skillswitch/state.json` persists switches, settings, usage stats
 *   and the optional uninstall trash.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

export const name = 'skillswitch'
export const inject = ['skills', 'tools', 'agents']

const SHADOW_PROVIDER = 'skillswitch'
const SHADOW_RANK = -1
const TOOL_NAME = 'skill_manage'
const API_PATH = '/api/skillswitch'
const PACKAGE_NAME = 'dsh-skillswitch'
const STATE_VERSION = 2
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PACK_FORMAT = 'dsh-skillswitch-pack'
const PACK_VERSION = 1
const PACK_VERSION_MULTI = 2
const MAX_PACK_FILE_BYTES = 2 * 1024 * 1024
const MAX_PACK_TOTAL_BYTES = 20 * 1024 * 1024
const MAX_PACK_FILES = 400
const MAX_PREVIEW_BYTES = 200 * 1024
const DISABLED_POLICIES = ['ask', 'deny', 'allow']
const DEFAULT_SETTINGS = { disabledSkillPolicy: 'ask', backupOnUninstall: false }

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function agentsHome() {
  return process.env.DSH_AGENTS_HOME || join(homedir(), '.agents')
}

function stateFilePath() {
  return join(dshHome(), 'skillswitch', 'state.json')
}

function trashRoot() {
  return join(dshHome(), 'skillswitch', 'trash')
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

function emptyState() {
  return {
    version: STATE_VERSION,
    disabled: {},
    settings: { ...DEFAULT_SETTINGS },
    stats: {},
    trash: [],
  }
}

function validTrashEntries(value) {
  if (!Array.isArray(value)) return []
  const entries = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.originalPath !== 'string' || typeof item.storedPath !== 'string') continue
    if (item.originalPath.length === 0 || item.storedPath.length === 0) continue
    entries.push({ originalPath: item.originalPath, storedPath: item.storedPath })
  }
  return entries
}

function readState(logger) {
  const file = stateFilePath()
  const empty = emptyState()
  try {
    if (!existsSync(file)) return empty
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const raw = parsed !== null && typeof parsed === 'object' ? parsed : {}
    const disabled = {}
    const rawDisabled = raw.disabled !== null && typeof raw.disabled === 'object' ? raw.disabled : {}
    for (const [key, value] of Object.entries(rawDisabled)) {
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
    const settings = { ...DEFAULT_SETTINGS }
    const rawSettings = raw.settings !== null && typeof raw.settings === 'object' ? raw.settings : {}
    if (typeof rawSettings.disabledSkillPolicy === 'string' && DISABLED_POLICIES.includes(rawSettings.disabledSkillPolicy)) {
      settings.disabledSkillPolicy = rawSettings.disabledSkillPolicy
    }
    if (typeof rawSettings.backupOnUninstall === 'boolean') settings.backupOnUninstall = rawSettings.backupOnUninstall
    const stats = {}
    const rawStats = raw.stats !== null && typeof raw.stats === 'object' ? raw.stats : {}
    for (const [key, value] of Object.entries(rawStats)) {
      if (!SKILL_NAME.test(key)) continue
      const record = value !== null && typeof value === 'object' ? value : {}
      stats[key] = {
        loads: typeof record.loads === 'number' && Number.isFinite(record.loads) && record.loads >= 0
          ? Math.floor(record.loads)
          : 0,
        lastUsedAt: typeof record.lastUsedAt === 'number' && Number.isFinite(record.lastUsedAt)
          ? record.lastUsedAt
          : 0,
      }
    }
    const trash = []
    const rawTrash = Array.isArray(raw.trash) ? raw.trash : []
    for (const item of rawTrash) {
      if (item === null || typeof item !== 'object') continue
      const entries = validTrashEntries(item.entries)
      if (entries.length === 0) continue
      trash.push({
        id: typeof item.id === 'string' && item.id.length > 0 ? item.id : `restored-${String(trash.length)}`,
        name: typeof item.name === 'string' && SKILL_NAME.test(item.name) ? item.name : 'unknown',
        removedAt: typeof item.removedAt === 'number' && Number.isFinite(item.removedAt) ? item.removedAt : 0,
        entries,
      })
    }
    return { version: STATE_VERSION, disabled, settings, stats, trash }
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

/** Recursively list regular files of one skill bundle, skipping VCS and deps. */
function collectBundleFiles(root) {
  const files = []
  const visit = (directory, prefix) => {
    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      if (entry.isSymbolicLink()) continue
      const absolute = join(directory, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) visit(absolute, relative)
      else if (entry.isFile()) files.push({ absolute, relative })
    }
  }
  visit(root, '')
  return files
}

/** Whether a pack-relative path may be materialized inside a new skill folder. */
function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return undefined
  if (value.includes('\\') || value.includes('\u0000') || value.startsWith('/')) return undefined
  const segments = value.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return undefined
  if (segments.some(segment => /[<>:"|?*]/u.test(segment))) return undefined
  return segments.join('/')
}

function decodePackFile(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const relative = safeRelativePath(entry.path)
  if (relative === undefined) return undefined
  if (typeof entry.contentBase64 !== 'string' || entry.contentBase64.length > MAX_PACK_FILE_BYTES * 2) return undefined
  let bytes
  try {
    bytes = Buffer.from(entry.contentBase64, 'base64')
  } catch {
    return undefined
  }
  if (bytes.byteLength > MAX_PACK_FILE_BYTES) return undefined
  return { relative, bytes }
}

export function apply(ctx) {
  const logger = ctx.logger ?? { info() {}, warn() {} }
  const state = readState(logger)
  const invalidators = new Set()
  const agentMounts = new Map()

  if (!Array.isArray(state.trash)) state.trash = []
  if (state.stats === null || typeof state.stats !== 'object') state.stats = {}
  if (state.settings === null || typeof state.settings !== 'object') state.settings = { ...DEFAULT_SETTINGS }

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

  function statsFor(entryName) {
    const record = state.stats[entryName]
    if (record === undefined) return { loads: 0, lastUsedAt: 0 }
    return { loads: record.loads, lastUsedAt: record.lastUsedAt }
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

  function newTrashId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  /** Move one removable entry into the trash folder, returning its record entry. */
  function stashEntry(target, recordId) {
    const stored = join(trashRoot(), recordId, basename(target))
    mkdirSync(dirname(stored), { recursive: true })
    try {
      renameSync(target, stored)
    } catch {
      cpSync(target, stored, { recursive: true })
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    return { originalPath: target, storedPath: stored }
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
    const targets = []
    for (const candidate of candidates) {
      const target = deletableEntry(candidate, roots)
      if (target === undefined || !existsSync(target)) continue
      if (!targets.includes(target)) targets.push(target)
    }
    if (targets.length === 0) {
      return {
        ok: false,
        message: `没有找到可卸载的 skill 文件。「${entryName}」可能是内置或打包技能，只能关闭（disable），不能卸载。`,
      }
    }
    const backup = state.settings.backupOnUninstall === true
    const recordId = newTrashId()
    const removed = []
    const stashed = []
    for (const target of targets) {
      try {
        if (backup) stashed.push(stashEntry(target, recordId))
        else rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        removed.push(target)
      } catch (error) {
        return { ok: false, message: `删除失败：${target}：${String(error)}` }
      }
    }
    if (stashed.length > 0) {
      state.trash.unshift({ id: recordId, name: entryName, removedAt: Date.now(), entries: stashed })
    }
    let stateChanged = stashed.length > 0
    if (state.disabled[entryName] !== undefined) {
      delete state.disabled[entryName]
      stateChanged = true
    }
    if (stateChanged) persist()
    refreshCatalog()
    return {
      ok: true,
      message: `${backup ? '已卸载并放入回收站' : '已卸载'} skill「${entryName}」，处理了 ${String(removed.length)} 个路径：${removed.join('、')}`,
      removed,
      backedUp: backup,
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
        const definition = await ctx.skills.get(entryName, { cwd: options.cwd, scope: options.scope })
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

  /** Collect one exportable skill into a pack entry, or report why it cannot. */
  async function collectSkillPack(entryName, options) {
    const summary = await findSkill(entryName, options)
    const path = typeof summary?.path === 'string' ? summary.path : ''
    if (summary === undefined || path === '') {
      return { ok: false, reason: `「${entryName}」没有技能文件（内置或虚拟技能不支持导出）。` }
    }
    if (!isRemovablePath(path, options.cwd)) {
      return { ok: false, reason: `「${entryName}」不在可导出的用户技能目录中。` }
    }
    let files
    let flatFile = false
    if (basename(path).toLowerCase() === 'skill.md') {
      files = collectBundleFiles(dirname(path))
    } else {
      files = [{ absolute: path, relative: basename(path) }]
      flatFile = true
    }
    if (files.length === 0) return { ok: false, reason: `「${entryName}」没有可读取的文件。` }
    if (files.length > MAX_PACK_FILES) return { ok: false, reason: `「${entryName}」文件数量超过上限。` }
    let totalBytes = 0
    const packed = []
    for (const file of files) {
      let stats
      try {
        stats = statSync(file.absolute)
      } catch (error) {
        return { ok: false, reason: `「${entryName}」读取失败：${String(error)}` }
      }
      if (!stats.isFile()) continue
      if (stats.size > MAX_PACK_FILE_BYTES) return { ok: false, reason: `「${entryName}」有文件过大（${file.relative}）。` }
      totalBytes += stats.size
      if (totalBytes > MAX_PACK_TOTAL_BYTES) return { ok: false, reason: `「${entryName}」总大小超过上限。` }
      packed.push({
        path: file.relative,
        size: stats.size,
        contentBase64: readFileSync(file.absolute).toString('base64'),
      })
    }
    return {
      ok: true,
      skill: { name: entryName, layout: flatFile ? 'file' : 'bundle', files: packed },
      fileCount: packed.length,
      totalBytes,
    }
  }

  async function exportSkill(entryName, options) {
    const collected = await collectSkillPack(entryName, options)
    if (collected.ok !== true) return { ok: false, message: `无法导出${collected.reason}` }
    const pack = {
      format: PACK_FORMAT,
      version: PACK_VERSION,
      exportedAt: new Date().toISOString(),
      ...collected.skill,
    }
    const data = Buffer.from(`${JSON.stringify(pack, null, 2)}\n`, 'utf8')
    return {
      ok: true,
      name: entryName,
      fileName: `${entryName}.skillpack.json`,
      fileCount: collected.fileCount,
      totalBytes: collected.totalBytes,
      dataBase64: data.toString('base64'),
    }
  }

  async function exportSkills(names, options) {
    if (!Array.isArray(names) || names.length === 0) {
      return { ok: false, message: '请至少选择一个技能。' }
    }
    if (names.length > 100) return { ok: false, message: '一次最多导出 100 个技能。' }
    const skills = []
    const skipped = []
    let fileCount = 0
    let totalBytes = 0
    for (const rawName of names) {
      const entryName = typeof rawName === 'string' ? rawName : ''
      if (!SKILL_NAME.test(entryName)) {
        skipped.push({ name: String(rawName), reason: '技能名不合法' })
        continue
      }
      const collected = await collectSkillPack(entryName, options)
      if (collected.ok !== true) {
        skipped.push({ name: entryName, reason: collected.reason })
        continue
      }
      skills.push(collected.skill)
      fileCount += collected.fileCount
      totalBytes += collected.totalBytes
    }
    if (skills.length === 0) {
      return { ok: false, message: '所选技能都无法导出。', skipped }
    }
    const pack = {
      format: PACK_FORMAT,
      version: PACK_VERSION_MULTI,
      exportedAt: new Date().toISOString(),
      skills,
    }
    const data = Buffer.from(`${JSON.stringify(pack, null, 2)}\n`, 'utf8')
    return {
      ok: true,
      fileName: `skillswitch-pack-${String(skills.length)}.skillpack.json`,
      skillCount: skills.length,
      fileCount,
      totalBytes,
      dataBase64: data.toString('base64'),
      skipped,
      message: `已导出 ${String(skills.length)} 个技能${skipped.length > 0 ? `，跳过 ${String(skipped.length)} 个` : ''}。`,
    }
  }

  function decodeSkillSpec(spec) {
    const source = spec !== null && typeof spec === 'object' ? spec : {}
    const skillName = typeof source.name === 'string' ? source.name : ''
    if (!SKILL_NAME.test(skillName)) return { error: `技能名不合法：${skillName || '(空)'}` }
    if (!Array.isArray(source.files) || source.files.length === 0) return { error: `技能「${skillName}」没有文件。` }
    if (source.files.length > MAX_PACK_FILES) return { error: `技能「${skillName}」文件数量超过上限。` }
    const files = []
    let totalBytes = 0
    for (const entry of source.files) {
      const decoded = decodePackFile(entry)
      if (decoded === undefined) return { error: `技能「${skillName}」包含非法文件条目。` }
      totalBytes += decoded.bytes.byteLength
      if (totalBytes > MAX_PACK_TOTAL_BYTES) return { error: `技能「${skillName}」总大小超过上限。` }
      files.push(decoded)
    }
    if (!files.some(file => file.relative.toLowerCase() === 'skill.md')) {
      return { error: `技能「${skillName}」缺少 SKILL.md。` }
    }
    return { name: skillName, files }
  }

  function importOneSkill(spec) {
    const targetDirectory = join(dshHome(), 'skills', spec.name)
    if (existsSync(targetDirectory)) {
      return { ok: false, reason: `已存在同名技能目录：${targetDirectory}` }
    }
    try {
      mkdirSync(targetDirectory, { recursive: true })
      for (const file of spec.files) {
        const destination = join(targetDirectory, ...file.relative.split('/'))
        if (!isInside(targetDirectory, destination)) throw new Error(`非法目标路径：${file.relative}`)
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, file.bytes)
      }
    } catch (error) {
      try {
        rmSync(targetDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch {
        // best effort cleanup only
      }
      return { ok: false, reason: `导入失败：${String(error)}` }
    }
    return { ok: true, name: spec.name, path: targetDirectory, fileCount: spec.files.length }
  }

  async function importPack(rawPack) {
    const pack = rawPack !== null && typeof rawPack === 'object' ? rawPack : {}
    if (pack.format !== PACK_FORMAT) return { ok: false, message: '不是有效的 skill pack（format 不匹配）。' }
    const specs = []
    if (pack.version === PACK_VERSION) {
      specs.push({ name: pack.name, files: pack.files })
    } else if (pack.version === PACK_VERSION_MULTI && Array.isArray(pack.skills)) {
      specs.push(...pack.skills)
    } else {
      return { ok: false, message: `不支持的 skill pack 版本：${String(pack.version)}` }
    }
    if (specs.length === 0) return { ok: false, message: '技能包为空。' }
    const imported = []
    const skipped = []
    for (const spec of specs) {
      const decoded = decodeSkillSpec(spec)
      if (decoded.error !== undefined) {
        skipped.push({ name: String((spec !== null && typeof spec === 'object' && spec.name) ?? ''), reason: decoded.error })
        continue
      }
      const result = importOneSkill(decoded)
      if (result.ok === true) imported.push({ name: result.name, path: result.path, fileCount: result.fileCount })
      else skipped.push({ name: decoded.name, reason: result.reason })
    }
    if (imported.length > 0) refreshCatalog()
    return {
      ok: imported.length > 0,
      message: imported.length === 0
        ? `没有导入任何技能${skipped.length > 0 ? `：${skipped.map(item => `${item.name}（${item.reason}）`).join('；')}` : ''}。`
        : `已导入 ${String(imported.length)} 个技能${skipped.length > 0 ? `，跳过 ${String(skipped.length)} 个：${skipped.map(item => item.name).join('、')}` : ''}。`,
      imported,
      skipped,
    }
  }

  function listTrash() {
    return state.trash.map(record => {
      let totalBytes = 0
      for (const entry of record.entries) {
        try {
          const stats = statSync(entry.storedPath)
          totalBytes += stats.isDirectory() ? 0 : stats.size
        } catch {
          // missing files keep the record visible
        }
      }
      return {
        id: record.id,
        name: record.name,
        removedAt: record.removedAt,
        entries: record.entries.length,
        totalBytes,
      }
    })
  }

  function restoreTrash(recordId) {
    if (typeof recordId !== 'string' || recordId.length === 0) {
      return { ok: false, message: '缺少回收站记录 id。' }
    }
    const index = state.trash.findIndex(record => record.id === recordId)
    if (index === -1) return { ok: false, message: '回收站记录不存在。' }
    const record = state.trash[index]
    const restored = []
    const skipped = []
    const remaining = []
    for (const entry of record.entries) {
      if (existsSync(entry.originalPath)) {
        skipped.push(entry.originalPath)
        remaining.push(entry)
        continue
      }
      try {
        mkdirSync(dirname(entry.originalPath), { recursive: true })
        cpSync(entry.storedPath, entry.originalPath, { recursive: true })
        rmSync(entry.storedPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        restored.push(entry.originalPath)
      } catch (error) {
        remaining.push(entry)
        logger.warn(`skillswitch: restore failed for ${entry.originalPath}: ${String(error)}`)
      }
    }
    state.trash[index] = { ...record, entries: remaining }
    if (remaining.length === 0) state.trash.splice(index, 1)
    persist()
    refreshCatalog()
    return {
      ok: restored.length > 0,
      message: restored.length === 0
        ? '没有恢复任何文件（目标位置已存在同名文件）。'
        : `已恢复 ${String(restored.length)} 个路径${skipped.length > 0 ? `，${String(skipped.length)} 个因目标已存在而跳过` : ''}。`,
      restored,
      skipped,
    }
  }

  function emptyTrash() {
    const root = trashRoot()
    let children = []
    try {
      children = readdirSync(root, { withFileTypes: true }).map(entry => entry.name)
    } catch {
      children = []
    }
    const failures = []
    for (const name of children) {
      try {
        rmSync(join(root, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch (error) {
        failures.push(`${name}（${String(error)}）`)
      }
    }
    // Keep only the records that still have files on disk.
    const remaining = state.trash.filter(record => record.entries.some(entry => existsSync(entry.storedPath)))
    const removedRecords = state.trash.length - remaining.length
    state.trash = remaining
    persist()
    return {
      ok: failures.length === 0 && remaining.length === 0,
      message: failures.length === 0 && remaining.length === 0
        ? `回收站已清空${removedRecords > 0 ? `（移除 ${String(removedRecords)} 条记录）` : ''}。`
        : `部分回收站条目无法删除：${failures.join('；')}`,
      removedRecords,
      failures,
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

  const listToolLines = skills => skills.map((skill) => {
    const usage = skill.loads > 0 ? `，加载 ${String(skill.loads)} 次` : '，从未加载'
    return `- ${skill.name}：${skill.disabled ? '已关闭' : '已开启'}，来源 ${skill.source}${skill.removable ? '，可卸载' : '，仅可关闭'}${usage}`
  })

  function policyReason(skillName) {
    const policy = state.settings.disabledSkillPolicy
    if (policy === 'deny') {
      return [
        `该 skill「${skillName}」已被用户关闭，且当前策略不允许模型自行开启。`,
        `不要尝试调用 ${TOOL_NAME} 开启它；如果任务确实需要，请让用户在「技能」页面手动开启。`,
      ].join('\n')
    }
    if (policy === 'allow') {
      return [
        `该 skill「${skillName}」已被关闭，当前不可加载。`,
        `当前策略允许模型自行开启：可调用 ${TOOL_NAME}(action="enable", name="${skillName}")，然后重试 skill。`,
      ].join('\n')
    }
    return [
      `该 skill「${skillName}」已被关闭，当前不可加载。`,
      `如需使用：先征询用户是否开启；用户同意后调用 ${TOOL_NAME}(action="enable", name="${skillName}") 开启，再正常调用 skill。`,
      '用户也可以在左侧边栏的「技能」页面手动开启。',
    ].join('\n')
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec?.name !== 'skill') return next()
    const argumentsValue = exec.arguments
    const requested = argumentsValue !== null && typeof argumentsValue === 'object'
      ? argumentsValue.name
      : undefined
    if (typeof requested !== 'string' || state.disabled[requested] === undefined) return next()
    return { kind: 'deny', reason: policyReason(requested) }
  })

  ctx.on('tools/result', (exec, result) => {
    if (exec?.name !== 'skill') return
    if (result?.isError === true) return
    const argumentsValue = exec.arguments
    const requested = argumentsValue !== null && typeof argumentsValue === 'object'
      ? argumentsValue.name
      : undefined
    if (typeof requested !== 'string' || !SKILL_NAME.test(requested)) return
    const current = statsFor(requested)
    state.stats[requested] = { loads: current.loads + 1, lastUsedAt: Date.now() }
    persist()
  })

  const manageTool = {
    name: TOOL_NAME,
    description: [
      'Manage installed skills. list shows every skill with its on/off state, usage count and whether it can be uninstalled.',
      'details returns one skill body (truncated) so you can inspect its instructions without loading it into the session.',
      'disable hides a skill from the session skill catalog and blocks the skill tool until it is enabled again.',
      'uninstall permanently deletes a user-installed skill from disk; shipped or packaged skills can only be disabled.',
      'Follow the configured disabled-skill policy: ask the user before enabling unless the policy allows otherwise.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'details', 'enable', 'disable', 'uninstall'],
          description: 'Operation to run.',
        },
        name: {
          type: 'string',
          description: 'Exact kebab-case skill name; required for details, enable, disable, and uninstall.',
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
            `共 ${String(skills.length)} 个 skill（已开启 ${String(skills.filter(skill => !skill.disabled).length)}，已关闭 ${String(skills.filter(skill => skill.disabled).length)}），策略：${state.settings.disabledSkillPolicy}：`,
            ...listToolLines(skills),
          ],
        }
      }
      if (action === 'details') {
        const result = await readSkill(entryName, options)
        if (result.ok !== true) return { ok: false, message: result.message }
        const bodyLines = String(result.content).split('\n').slice(0, 120)
        return {
          ok: true,
          lines: [
            `skill「${result.name}」：${result.source} / ${result.provider}`,
            result.path !== '' ? `路径：${result.path}` : '路径：无（虚拟技能）',
            result.truncated ? '（正文已截断）' : '',
            '---',
            ...bodyLines,
          ].filter(line => line !== ''),
        }
      }
      if (action === 'enable' || action === 'disable') {
        const result = await setEnabled(entryName, action === 'enable', options, 'model')
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
    const agent = pickAgent()
    const options = await contextFor(agent, undefined)
    if (action === 'list') {
      return {
        ok: true,
        skills: await listSkills(options),
        statePath: stateFilePath(),
        version: readOwnVersion(),
        view: currentView(agent, options),
        settings: settingsView(),
        trash: listTrash(),
      }
    }
    if (action === 'setEnabled') {
      return setEnabled(typeof payload.name === 'string' ? payload.name : '', payload.enabled !== false, options, 'user')
    }
    if (action === 'uninstall') {
      return uninstall(typeof payload.name === 'string' ? payload.name : '', options)
    }
    if (action === 'checkUpdate') {
      return checkUpdate(logger)
    }
    if (action === 'readSkill') {
      return readSkill(typeof payload.name === 'string' ? payload.name : '', options)
    }
    if (action === 'exportSkill') {
      return exportSkill(typeof payload.name === 'string' ? payload.name : '', options)
    }
    if (action === 'exportSkills') {
      return exportSkills(Array.isArray(payload.names) ? payload.names : [], options)
    }
    if (action === 'importPack') {
      return importPack(payload.pack)
    }
    if (action === 'listTrash') {
      return { ok: true, trash: listTrash() }
    }
    if (action === 'restoreTrash') {
      return restoreTrash(typeof payload.id === 'string' ? payload.id : '')
    }
    if (action === 'emptyTrash') {
      return emptyTrash()
    }
    if (action === 'updateSettings') {
      return updateSettings(payload.settings)
    }
    if (action === 'clearStats') {
      return clearStats()
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

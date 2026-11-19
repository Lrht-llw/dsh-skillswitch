/**
 * Persistent state and filesystem helpers for Skillswitch.
 *
 * Owns the state file (`$DSH_HOME/skillswitch/state.json`), the writable skill
 * roots, and the small path utilities shared by the other modules. No module
 * imports this one except through explicit imports; it has no project
 * dependencies of its own.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

export const STATE_VERSION = 2
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const DISABLED_POLICIES = ['ask', 'deny', 'allow']
export const DEFAULT_SETTINGS = { disabledSkillPolicy: 'ask', backupOnUninstall: false }

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function agentsHome() {
  return process.env.DSH_AGENTS_HOME || join(homedir(), '.agents')
}

export function stateFilePath() {
  return join(dshHome(), 'skillswitch', 'state.json')
}

export function trashRoot() {
  return join(dshHome(), 'skillswitch', 'trash')
}

export function normalizePath(value) {
  const absolute = resolve(value)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function isInside(root, target) {
  const normalizedRoot = normalizePath(root)
  const normalizedTarget = normalizePath(target)
  return normalizedTarget === normalizedRoot
    || normalizedTarget.startsWith(normalizedRoot + sep)
}

export function normalizeDescription(value) {
  if (typeof value !== 'string') return ''
  return value.replaceAll(/\s+/gu, ' ').trim()
}

export function emptyState() {
  return {
    version: STATE_VERSION,
    disabled: {},
    settings: { ...DEFAULT_SETTINGS },
    stats: {},
    trash: [],
    pendingCleanup: [],
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

/** Read and normalize the persisted state; malformed data falls back to defaults. */
export function readState(logger) {
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
    // Leftover trash directories a transient Windows lock kept from deletion.
    const pendingCleanup = []
    const rawPending = Array.isArray(raw.pendingCleanup) ? raw.pendingCleanup : []
    for (const item of rawPending) {
      if (typeof item !== 'string' || item.length === 0 || item.length > 2048) continue
      if (pendingCleanup.length >= 200) break
      pendingCleanup.push(item)
    }
    return { version: STATE_VERSION, disabled, settings, stats, trash, pendingCleanup }
  } catch (error) {
    logger.warn(`skillswitch: cannot read ${file}: ${String(error)}`)
    return empty
  }
}

/**
 * Persist state atomically, retrying a transient Windows rename lock and
 * falling back to a direct write. A failed write is reported, never silent.
 */
export function writeState(state, logger) {
  const file = stateFilePath()
  const directory = dirname(file)
  const temporary = `${file}.${process.pid}.tmp`
  const payload = `${JSON.stringify(state, null, 2)}\n`
  const writeDirect = () => {
    try {
      writeFileSync(file, payload, 'utf8')
    } catch (error) {
      logger.warn(`skillswitch: cannot write ${file}: ${String(error)}`)
    }
  }
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(temporary, payload, 'utf8')
    let renamed = false
    for (let attempt = 0; attempt < 5 && !renamed; attempt += 1) {
      try {
        renameSync(temporary, file)
        renamed = true
      } catch (error) {
        if (attempt === 4) {
          logger.warn(`skillswitch: atomic replace failed, writing directly: ${String(error)}`)
          writeDirect()
        } else {
          const deadline = Date.now() + 60
          while (Date.now() < deadline) {
            // briefly wait for a transient Windows file lock to settle
          }
        }
      }
    }
  } catch (error) {
    logger.warn(`skillswitch: cannot stage state file: ${String(error)}`)
    writeDirect()
  } finally {
    try {
      rmSync(temporary, { force: true, maxRetries: 2, retryDelay: 50 })
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
export function writableRoots(cwd) {
  const roots = [join(dshHome(), 'skills'), join(agentsHome(), 'skills')]
  if (typeof cwd === 'string' && cwd.length > 0) {
    roots.push(join(cwd, '.dsh', 'skills'), join(cwd, '.agents', 'skills'))
  }
  return [...new Set(roots.map(root => resolve(root)))]
}

/** Deletable skill entry (a bundle directory or a flat `.md` file) or undefined. */
export function deletableEntry(candidatePath, roots) {
  if (typeof candidatePath !== 'string' || candidatePath.length === 0) return undefined
  const absolute = resolve(candidatePath)
  const target = absolute.toLowerCase().endsWith(`${sep}skill.md`) ? dirname(absolute) : absolute
  const parent = dirname(target)
  return roots.some(root => normalizePath(root) === normalizePath(parent)) ? target : undefined
}

export function isRemovablePath(candidatePath, cwd) {
  return deletableEntry(candidatePath, writableRoots(cwd)) !== undefined
}

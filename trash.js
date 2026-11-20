/**
 * Uninstall and trash operations for Skillswitch.
 *
 * Uninstalling a user skill deletes its files, optionally moving them into the
 * trash folder first. Restoring copies them back and removes the trashed copy;
 * emptying the trash deletes leftovers one entry at a time.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import {
  SKILL_NAME,
  deletableEntry,
  trashRoot,
  writableRoots,
} from './state.js'

export function createTrash({ state, logger, persist, refreshCatalog, findSkill }) {
  if (!Array.isArray(state.pendingCleanup)) state.pendingCleanup = []

  function markPending(target) {
    if (typeof target !== 'string' || target.length === 0) return
    if (!state.pendingCleanup.includes(target)) state.pendingCleanup.push(target)
  }

  /** Retry directories a transient lock kept from deletion on earlier runs. */
  function flushPending() {
    if (state.pendingCleanup.length === 0) return
    const remaining = []
    for (const target of state.pendingCleanup) {
      if (!removeTree(target) && existsSync(target)) remaining.push(target)
    }
    if (remaining.length !== state.pendingCleanup.length) {
      state.pendingCleanup = remaining
      persist()
    }
  }

  /** Remove a tree, retrying once after a short pause for a transient Windows lock. */
  function removeTree(target) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      return true
    } catch {
      try {
        const pause = new Int32Array(new SharedArrayBuffer(4))
        Atomics.wait(pause, 0, 0, 1500)
        rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
        return true
      } catch {
        return false
      }
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
      removeTree(target)
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
        else if (!removeTree(target)) throw new Error('remove failed')
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
    if (state.stats !== null && typeof state.stats === 'object' && state.stats[entryName] !== undefined) {
      delete state.stats[entryName]
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
        removeTree(entry.storedPath)
        try {
          rmdirSync(dirname(entry.storedPath))
        } catch {
          markPending(dirname(entry.storedPath))
        }
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
      if (!removeTree(join(root, name))) failures.push(join(root, name))
    }
    // Second pass for entries a transient lock kept open during the first sweep.
    const stillFailed = []
    for (const target of failures) {
      if (!removeTree(target)) stillFailed.push(target)
    }
    for (const target of stillFailed) markPending(target)
    flushPending()
    // Keep only the records that still have files on disk.
    const remaining = state.trash.filter(record => record.entries.some(entry => existsSync(entry.storedPath)))
    const removedRecords = state.trash.length - remaining.length
    state.trash = remaining
    persist()
    return {
      ok: true,
      message: stillFailed.length === 0
        ? `回收站已清空${removedRecords > 0 ? `（移除 ${String(removedRecords)} 条记录）` : ''}。`
        : `回收站记录已清空；${String(stillFailed.length)} 个目录被系统短暂占用，稍后会自动重试清理。`,
      removedRecords,
      pending: stillFailed.length,
    }
  }

  return { uninstall, listTrash, restoreTrash, emptyTrash, flushPending }
}

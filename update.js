/**
 * Update checking for Skillswitch.
 *
 * Reads the running package version, compares semver cores, and asks npm (or
 * the npmmirror fallback) for the newest published version. Network access
 * happens only when this function is called; no timers or background work.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const PACKAGE_NAME = 'dsh-skillswitch'

const UPDATE_SOURCES = [
  `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
  `https://registry.npmmirror.com/${PACKAGE_NAME}/latest`,
]

/** Version of the running package, read from the manifest beside this module. */
export function readOwnVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    if (typeof manifest.version === 'string' && manifest.version !== '') return manifest.version
  } catch {
    // Some loaders hand plugin modules a URL that is not a readable file path;
    // fall through to the version pinned by the profile that loaded us.
  }
  try {
    const profileDir = process.env.DSH_PROFILE_DIR
    if (typeof profileDir === 'string' && profileDir !== '') {
      const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
      const pinned = profile?.dependencies?.[PACKAGE_NAME]
      if (typeof pinned === 'string') {
        const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/u.exec(pinned.trim())
        if (match !== null) return match[1]
      }
    }
  } catch {
    // fall through
  }
  return ''
}

/** Parse a semver core and pre-release tag into comparable parts. */
export function parseVersion(value) {
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
export function compareVersions(left, right) {
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

/** Compare the running version with the newest published npm version. */
export async function checkUpdate(logger) {
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

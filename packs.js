/**
 * Skill pack export and import for Skillswitch.
 *
 * A pack is a JSON document: version 1 carries one skill, version 2 carries a
 * `skills` array. Export reads a user skill bundle (or a flat `.md` skill) into
 * base64 file entries; import materializes packs under `$DSH_HOME/skills`
 * without overwriting an existing skill.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import {
  SKILL_NAME,
  dshHome,
  isInside,
  isRemovablePath,
} from './state.js'

const PACK_FORMAT = 'dsh-skillswitch-pack'
const PACK_VERSION = 1
const PACK_VERSION_MULTI = 2
const MAX_PACK_FILE_BYTES = 2 * 1024 * 1024
const MAX_PACK_TOTAL_BYTES = 20 * 1024 * 1024
const MAX_PACK_FILES = 400

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

export function createPacks({ findSkill, refreshCatalog, logger }) {
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

  return { collectSkillPack, exportSkill, exportSkills, importPack }
}

export { PACK_FORMAT, PACK_VERSION, PACK_VERSION_MULTI, MAX_PACK_FILES, MAX_PACK_FILE_BYTES, MAX_PACK_TOTAL_BYTES }

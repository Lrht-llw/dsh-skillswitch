/**
 * Skill pack export and import for Skillswitch.
 *
 * Pack versions:
 * - v1: one skill (`name`, `files`);
 * - v2: several skills (`skills` array);
 * - v3: several skills plus generated configuration-only MCP bundles and plugin
 *   requirements, so a skill that depends on tools can travel with the config
 *   that provides them. Secrets are never exported: sensitive values become
 *   `!!js process.env.<KEY>` references and a credential hint.
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
const PACK_VERSION_BUNDLE = 3
const MAX_PACK_FILE_BYTES = 2 * 1024 * 1024
const MAX_PACK_TOTAL_BYTES = 20 * 1024 * 1024
const MAX_PACK_FILES = 400
const MAX_BUNDLE_FILES = 40
const DEPENDENCY_FILE = 'skillswitch.json'
const SENSITIVE_KEY = /(token|key|secret|password|authorization|cookie|credential|api[-_]?key)/iu
const MCP_PACKAGE = '@deepseek-ai/dsh-mcp-client'

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

/** Whether a pack-relative path may be materialized inside a new folder. */
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

function isSensitiveKey(value) {
  return typeof value === 'string' && SENSITIVE_KEY.test(value)
}

function yamlScalar(value) {
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(String(value))
}

/** Render a plain JS value (or `{ __js }` reference) as block YAML. */
function yamlBlock(value, indent) {
  const pad = ' '.repeat(indent)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `${pad}${yamlScalar(value)}`
  }
  if (typeof value.__js === 'string') return `${pad}!!js ${value.__js}`
  const lines = []
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item) && typeof item.__js !== 'string') {
      lines.push(`${pad}${key}:`)
      lines.push(yamlBlock(item, indent + 2))
    } else if (Array.isArray(item)) {
      lines.push(`${pad}${key}:`)
      for (const element of item) lines.push(`${pad}  - ${yamlScalar(element)}`)
    } else if (item !== null && typeof item === 'object' && typeof item.__js === 'string') {
      lines.push(`${pad}${key}: !!js ${item.__js}`)
    } else {
      lines.push(`${pad}${key}: ${yamlScalar(item)}`)
    }
  }
  return lines.join('\n')
}

function mcpBundleName(skillName, serverName) {
  return `skillswitch-${skillName}-${serverName}-mcp`
}

function bundleFilesForMcp(skillName, dependency) {
  const serverName = String(dependency.serverName)
  const transport = dependency.transport === 'stdio' ? 'stdio' : 'streamable-http'
  const bundleName = mcpBundleName(skillName, serverName)
  const credentials = []
  const config = { serverName, transport, failOnStartupError: dependency.failOnStartupError !== false }
  if (transport === 'stdio') {
    config.command = dependency.command
    if (Array.isArray(dependency.args)) config.args = dependency.args
  } else {
    config.url = dependency.url
  }
  for (const field of ['env', 'headers']) {
    const source = dependency[field]
    if (source === null || typeof source !== 'object') continue
    const target = {}
    for (const [key, value] of Object.entries(source)) {
      if (isSensitiveKey(key)) {
        target[key] = { __js: `String(process.env.${key} ?? '')` }
        credentials.push(key)
      } else {
        target[key] = value
      }
    }
    config[field] = target
  }
  const patch = [
    '- insert:',
    `    - id: ${bundleName}`,
    `      name: '${MCP_PACKAGE}'`,
    '      config:',
    yamlBlock(config, 8),
    '',
  ].join('\n')
  const manifest = {
    name: `@local/${bundleName}`,
    version: '1.0.0',
    private: true,
    type: 'module',
    files: ['cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    description: `MCP bundle generated by Skillswitch for skill "${skillName}" (server "${serverName}").`,
  }
  return {
    name: bundleName,
    mcp: { serverName, transport, command: config.command, url: config.url },
    credentials,
    files: [
      { path: 'package.json', contentBase64: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8').toString('base64') },
      { path: 'cordis.patch.yml', contentBase64: Buffer.from(patch, 'utf8').toString('base64') },
    ],
  }
}

function readSkillDependencies(skillRoot) {
  const file = join(skillRoot, DEPENDENCY_FILE)
  try {
    if (!existsSync(file)) return { mcp: [], plugins: [] }
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''))
    const requires = parsed !== null && typeof parsed === 'object' && parsed.requires !== null && typeof parsed.requires === 'object'
      ? parsed.requires
      : {}
    const mcp = Array.isArray(requires.mcp)
      ? requires.mcp.filter(item => item !== null && typeof item === 'object' && typeof item.serverName === 'string' && item.serverName.length > 0)
      : []
    const plugins = Array.isArray(requires.plugins)
      ? requires.plugins.filter(item => typeof item === 'string' && item.length > 0)
      : []
    return { mcp, plugins }
  } catch {
    return { mcp: [], plugins: [] }
  }
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
    // The registry may report either the skill file (SKILL.md) or its directory.
    let skillRoot
    try {
      if (statSync(path).isDirectory()) skillRoot = path
      else if (basename(path).toLowerCase() === 'skill.md') skillRoot = dirname(path)
    } catch {
      skillRoot = undefined
    }
    let files
    let flatFile = false
    if (skillRoot !== undefined) {
      files = collectBundleFiles(skillRoot)
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
    const dependencies = skillRoot !== undefined ? readSkillDependencies(skillRoot) : { mcp: [], plugins: [] }
    return {
      ok: true,
      skill: { name: entryName, layout: flatFile ? 'file' : 'bundle', files: packed },
      dependencies,
      fileCount: packed.length,
      totalBytes,
    }
  }

  function packDocument(skills, bundles, plugins) {
    return {
      format: PACK_FORMAT,
      version: PACK_VERSION_BUNDLE,
      exportedAt: new Date().toISOString(),
      skills,
      bundles,
      plugins,
    }
  }

  async function exportSkill(entryName, options) {
    return exportSkills([entryName], options)
  }

  async function exportSkills(names, options) {
    if (!Array.isArray(names) || names.length === 0) {
      return { ok: false, message: '请至少选择一个技能。' }
    }
    if (names.length > 100) return { ok: false, message: '一次最多导出 100 个技能。' }
    const skills = []
    const skipped = []
    const bundles = []
    const plugins = new Set()
    const credentials = new Set()
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
      for (const dependency of collected.dependencies.mcp) {
        const bundle = bundleFilesForMcp(entryName, dependency)
        if (bundle.files.length > MAX_BUNDLE_FILES) continue
        bundles.push(bundle)
        for (const key of bundle.credentials) credentials.add(key)
      }
      for (const plugin of collected.dependencies.plugins) plugins.add(plugin)
    }
    if (skills.length === 0) {
      return { ok: false, message: '所选技能都无法导出。', skipped }
    }
    const pack = packDocument(skills, bundles, [...plugins])
    const data = Buffer.from(`${JSON.stringify(pack, null, 2)}\n`, 'utf8')
    const parts = [`已导出 ${String(skills.length)} 个技能`]
    if (bundles.length > 0) parts.push(`${String(bundles.length)} 个 MCP 依赖 bundle`)
    if (plugins.size > 0) parts.push(`${String(plugins.size)} 个插件依赖`)
    if (skipped.length > 0) parts.push(`跳过 ${String(skipped.length)} 个`)
    return {
      ok: true,
      fileName: `skillswitch-pack-${String(skills.length)}.skillpack.json`,
      skillCount: skills.length,
      fileCount,
      totalBytes,
      dataBase64: data.toString('base64'),
      bundles: bundles.map(bundle => ({ name: bundle.name, mcp: bundle.mcp, credentials: bundle.credentials })),
      plugins: [...plugins],
      credentials: [...credentials],
      skipped,
      message: `${parts.join('，')}。`,
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

  function decodeBundleSpec(spec) {
    const source = spec !== null && typeof spec === 'object' ? spec : {}
    const name = typeof source.name === 'string' ? source.name : ''
    if (!/^[a-z0-9][a-z0-9._-]{0,80}$/iu.test(name)) return { error: `依赖 bundle 名称不合法：${name || '(空)'}` }
    if (!Array.isArray(source.files) || source.files.length === 0) return { error: `依赖 bundle「${name}」没有文件。` }
    if (source.files.length > MAX_BUNDLE_FILES) return { error: `依赖 bundle「${name}」文件数量超过上限。` }
    const files = []
    for (const entry of source.files) {
      const decoded = decodePackFile(entry)
      if (decoded === undefined) return { error: `依赖 bundle「${name}」包含非法文件条目。` }
      files.push(decoded)
    }
    const hasManifest = files.some(file => file.relative === 'package.json')
    const hasPatch = files.some(file => file.relative === 'cordis.patch.yml')
    if (!hasManifest || !hasPatch) return { error: `依赖 bundle「${name}」缺少 package.json 或 cordis.patch.yml。` }
    return {
      name,
      files,
      mcp: source.mcp !== null && typeof source.mcp === 'object' ? source.mcp : {},
      credentials: Array.isArray(source.credentials) ? source.credentials.filter(item => typeof item === 'string') : [],
    }
  }

  function importOneBundle(spec) {
    const root = join(dshHome(), 'skillswitch', 'bundles')
    const targetDirectory = join(root, spec.name)
    if (existsSync(targetDirectory)) {
      return { ok: false, reason: `已存在同名依赖 bundle：${targetDirectory}` }
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
      return { ok: false, reason: `依赖 bundle 写入失败：${String(error)}` }
    }
    return {
      ok: true,
      name: spec.name,
      path: targetDirectory,
      mcp: spec.mcp,
      credentials: spec.credentials,
    }
  }

  async function importPack(rawPack) {
    const pack = rawPack !== null && typeof rawPack === 'object' ? rawPack : {}
    if (pack.format !== PACK_FORMAT) return { ok: false, message: '不是有效的 skill pack（format 不匹配）。' }
    const specs = []
    const bundleSpecs = []
    if (pack.version === PACK_VERSION) {
      specs.push({ name: pack.name, files: pack.files })
    } else if (pack.version === PACK_VERSION_MULTI && Array.isArray(pack.skills)) {
      specs.push(...pack.skills)
    } else if (pack.version === PACK_VERSION_BUNDLE && Array.isArray(pack.skills)) {
      specs.push(...pack.skills)
      if (Array.isArray(pack.bundles)) bundleSpecs.push(...pack.bundles)
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
    const bundles = []
    const bundleSkipped = []
    for (const spec of bundleSpecs) {
      const decoded = decodeBundleSpec(spec)
      if (decoded.error !== undefined) {
        bundleSkipped.push({ name: String((spec !== null && typeof spec === 'object' && spec.name) ?? ''), reason: decoded.error })
        continue
      }
      const result = importOneBundle(decoded)
      if (result.ok === true) {
        bundles.push({
          name: result.name,
          path: result.path,
          mcp: result.mcp,
          credentials: result.credentials,
        })
      } else {
        bundleSkipped.push({ name: decoded.name, reason: result.reason })
      }
    }
    const plugins = Array.isArray(pack.plugins)
      ? pack.plugins.filter(item => typeof item === 'string' && item.length > 0)
      : []
    if (imported.length > 0) refreshCatalog()
    const parts = []
    parts.push(imported.length === 0 ? '没有导入任何技能' : `已导入 ${String(imported.length)} 个技能`)
    if (bundles.length > 0) parts.push(`${String(bundles.length)} 个依赖 bundle 已就绪（待安装）`)
    if (plugins.length > 0) parts.push(`${String(plugins.length)} 个插件依赖待处理`)
    if (skipped.length > 0) parts.push(`技能跳过 ${String(skipped.length)} 个`)
    return {
      ok: imported.length > 0,
      message: `${parts.join('，')}。`,
      imported,
      skipped,
      bundles,
      bundleSkipped,
      plugins,
    }
  }

  return {
    collectSkillPack,
    exportSkill,
    exportSkills,
    importPack,
    dependencyDirectory: () => join(dshHome(), 'skillswitch', 'bundles'),
  }
}

export {
  PACK_FORMAT,
  PACK_VERSION,
  PACK_VERSION_MULTI,
  PACK_VERSION_BUNDLE,
  MAX_PACK_FILES,
  MAX_PACK_FILE_BYTES,
  MAX_PACK_TOTAL_BYTES,
  DEPENDENCY_FILE,
}

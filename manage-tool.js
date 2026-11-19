/**
 * The model-facing `skill_manage` tool for Skillswitch.
 *
 * The tool shares the same operations as the page: list, details, enable,
 * disable, uninstall. Policy enforcement lives in `policy.js` at
 * `tools/pre-execute`, so this file only defines the schema and dispatch.
 */

import { TOOL_NAME } from './policy.js'

function listToolLines(skills) {
  return skills.map((skill) => {
    const usage = skill.loads > 0 ? `，加载 ${String(skill.loads)} 次` : '，从未加载'
    return `- ${skill.name}：${skill.disabled ? '已关闭' : '已开启'}，来源 ${skill.source}${skill.removable ? '，可卸载' : '，仅可关闭'}${usage}`
  })
}

export function createManageTool({
  contextFor,
  listSkills,
  readSkill,
  setEnabled,
  uninstall,
  getPolicy,
}) {
  return {
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
            `共 ${String(skills.length)} 个 skill（已开启 ${String(skills.filter(skill => !skill.disabled).length)}，已关闭 ${String(skills.filter(skill => skill.disabled).length)}），策略：${getPolicy()}：`,
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
}

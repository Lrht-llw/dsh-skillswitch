/**
 * Disabled-skill policy for Skillswitch.
 *
 * One pure function turns a `tools/pre-execute` call into a DSH decision:
 * calling a disabled skill is always denied; enabling one is allowed, denied,
 * or sent to the user for one explicit approval, depending on the setting.
 */

export const TOOL_NAME = 'skill_manage'

/** Model-facing reason shown when the model loads a disabled skill. */
export function policyReason(policy, skillName) {
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

/**
 * Decide one `tools/pre-execute` call.
 *
 * @returns `undefined` to let the call continue, or a DSH decision object.
 */
export function decidePreTool(exec, { policy, disabled, toolName = TOOL_NAME, approvalDisabled = false }) {
  if (exec === undefined) return undefined
  const argumentsValue = exec.arguments
  if (exec.name === 'skill') {
    const requested = argumentsValue !== null && typeof argumentsValue === 'object'
      ? argumentsValue.name
      : undefined
    if (typeof requested !== 'string' || disabled[requested] === undefined) return undefined
    return { kind: 'deny', reason: policyReason(policy, requested) }
  }
  if (exec.name !== toolName) return undefined
  const action = argumentsValue !== null && typeof argumentsValue === 'object' ? argumentsValue.action : undefined
  const target = argumentsValue !== null && typeof argumentsValue === 'object' ? argumentsValue.name : undefined
  if (action !== 'enable' || typeof target !== 'string' || disabled[target] === undefined) return undefined
  if (policy === 'allow') return undefined
  if (policy === 'deny') {
    return {
      kind: 'deny',
      reason: [
        `当前策略不允许模型自行开启技能（技能「${target}」仍处于关闭状态）。`,
        '请让用户在「技能」页面手动开启，或请用户修改关闭策略。',
      ].join('\n'),
    }
  }
  // A session that disables approval prompts would turn the ask below into an
  // opaque automatic rejection, so answer with the real reason instead.
  if (approvalDisabled) {
    return {
      kind: 'deny',
      reason: [
        `该 skill「${target}」已被关闭。当前会话禁用了审批提示（approval policy = never），模型无法通过审批开启它。`,
        '请让用户在左侧边栏的「技能」页面手动开启；如果希望模型能自行开启，可让用户把关闭策略改为「允许模型自行开启」（allow）。',
      ].join('\n'),
    }
  }
  // ask: one explicit user approval is required before the model may enable a skill.
  return {
    kind: 'ask',
    reason: `skillswitch: enable disabled skill "${target}"`,
    displayReason: {
      en: `Allow this agent to enable the disabled skill "${target}"?`,
      zh: `允许 agent 启用已关闭的技能「${target}」吗？`,
    },
  }
}

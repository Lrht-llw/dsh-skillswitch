/**
 * HTTP API for the Skillswitch page.
 *
 * One authenticated POST endpoint (`/api/skillswitch`) dispatches the same
 * operations the model tool exposes. Authentication is provided by DSH's
 * connection fetch registration, so this module only owns dispatch and route
 * registration.
 */

export const API_PATH = '/api/skillswitch'

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

export function createApi({
  contextFor,
  pickAgent,
  currentView,
  settingsView,
  listSkills,
  setEnabled,
  uninstall,
  readSkill,
  exportSkill,
  exportSkills,
  importPack,
  listTrash,
  restoreTrash,
  emptyTrash,
  updateSettings,
  clearStats,
  checkUpdate,
  readOwnVersion,
  stateFilePath,
  logger,
  installDependency,
  removeDependency,
  dependencyStatus,
}) {
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
    if (action === 'installDependency') {
      return installDependency(payload)
    }
    if (action === 'removeDependency') {
      return removeDependency(payload)
    }
    if (action === 'dependencyStatus') {
      return dependencyStatus(payload.bundles, payload.plugins)
    }
    return { ok: false, message: `未知操作：${action || '(空)'}` }
  }

  return { dispatch }
}

/** Register the authenticated POST route on the DSH connection service. */
export function registerHttpRoute(ctx, { apiPath = API_PATH, dispatch, logger } = {}) {
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection
    if (connection === undefined || connection.fetch === undefined) return
    connectionCtx.effect(() => {
      const dispose = connection.fetch.register({
        path: apiPath,
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

/**
 * dsh-work-log — 把每一次对话整理成可复用的工作记录。
 *
 * 每个「对话」一个 JSON 文件，路径为：
 *   <root> / <工作区目录名> / <对话标题>.json
 *
 * 每一轮结束后写入一条记录：{ index, time, turn, content }，
 * 其中 content 默认交给当前默认模型精简成「用户要求 + 实际结果」，
 * 便于当作另一个机器人的上下文使用；模型不可用时退回原文摘要。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-work-log'

/** `llm` 是硬依赖：没有它就只能记原文，但插件仍可加载。 */
export const inject = ['llm']

export const Config = z.object({
  root: z.string().default('E:\\DSH-WorkLogs'),
  enabled: z.boolean().default(true),
  summarize: z.boolean().default(true),
})

const DEFAULT_ROOT = 'E:\\DSH-WorkLogs'
const PLUGIN_VERSION = '0.2.0'
/** 界面改过的配置写在这里，优先于 bundle patch 里的行配置。 */
const CONFIG_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'work-log', 'config.json')
const MAX_USER = 1500
const MAX_ASSISTANT = 3000
const MAX_RECORD_CHARS = 4000

const SUMMARY_SYSTEM = [
  '你在替一个 AI 助手写工作日志。读者是另一个 AI，它会把这条记录当作聊天上下文，读完后要能相信「我们刚刚确实一起做过这件事」。',
  '',
  '写一条第一人称复数的叙述记录（"你让我…我…"），要求：',
  '1. 开头写清用户这一轮到底要什么——概括意图，不要照抄原话。',
  '2. 中段写实际做了什么，尽量点名具体动作：改了哪个文件或模块、跑了什么命令、查了什么、做了什么判断。',
  '3. 结尾写结果或留下的状态（成功交付、被什么挡住、下次要注意什么）。',
  '4. 只允许写「动作清单」里出现过的事实；清单里没有的操作不要编造。',
  '5. 具体、可核对，像同事之间复盘；不要客套，不要"好的/已为您"，不要 markdown 列表，不要引号。',
  '6. 长度 120~220 字，一到两段。',
].join('\n')

function readStoredConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(Buffer.byteLength(body)))
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/** 从消息内容块里取出纯文本。 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/** 截断到指定字符数（按码点，不劈开代理对）。 */
function clip(text, limit) {
  const chars = [...String(text ?? '')]
  return chars.length <= limit ? chars.join('') : `${chars.slice(0, limit).join('')}…`
}

/** 去掉文件名里的非法字符。 */
function safeName(raw, fallback) {
  const cleaned = String(raw ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^\.+$/u, '')
  const cut = [...cleaned].slice(0, 60).join('').trim()
  return cut === '' ? fallback : cut
}

/** 把一次工具调用压成一行人能看懂的动作，例如 `write index.js`。 */
function actionLabel(name, argsJson) {
  let hint = ''
  try {
    const args = JSON.parse(argsJson ?? '{}')
    const candidate = args.path ?? args.file_path ?? args.command ?? args.query ?? args.pattern ?? args.prompt ?? args.app
    if (typeof candidate === 'string') hint = clip(candidate.replace(/\s+/gu, ' '), 80)
  } catch {
    // 参数不是 JSON：只用工具名
  }
  return hint === '' ? String(name) : `${name} ${hint}`
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function stamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function apply(ctx, config) {
  const stored = readStoredConfig()
  const settings = {
    root: typeof config?.root === 'string' && config.root.trim() !== '' ? config.root.trim() : DEFAULT_ROOT,
    enabled: config?.enabled !== false,
    summarize: config?.summarize !== false,
  }
  // 界面上保存过的值覆盖 bundle patch 里的默认值
  if (typeof stored.root === 'string' && stored.root.trim() !== '') settings.root = stored.root.trim()
  if (typeof stored.enabled === 'boolean') settings.enabled = stored.enabled
  if (typeof stored.summarize === 'boolean') settings.summarize = stored.summarize

  /** sessionId -> 会话级状态 */
  const states = new Map()

  function stateOf(session) {
    const id = String(session.id)
    let state = states.get(id)
    if (state === undefined) {
      state = { id, cwd: session.header?.cwd, users: [], assistants: [], actions: [], chain: Promise.resolve(), file: undefined, data: undefined }
      states.set(id, state)
    }
    return state
  }

  ctx.effect(() => () => {
    states.clear()
  }, 'dsh-work-log.state')

  /** 当前默认模型路由；拿不到就返回 undefined，由上层退回原文。 */
  async function pickRoute(llm) {
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      // 忽略：退回 provider 目录
    }
    try {
      const provider = llm.listProviders?.()[0]?.id
      if (typeof provider !== 'string') return undefined
      const models = await llm.listModels(provider)
      const model = models?.[0]?.id
      return typeof model === 'string' ? { provider, model } : undefined
    } catch {
      return undefined
    }
  }

  /** 让当前默认模型把一轮对话写成一条叙述式工作记录。失败返回 undefined。 */
  async function summarize(llm, userText, assistantText, actions) {
    const route = await pickRoute(llm)
    if (route === undefined) return undefined
    const actionText = actions.length === 0
      ? '（这一轮没有工具调用）'
      : actions.map((action, index) => `${index + 1}. ${action}`).join('\n')
    const prompt = `用户这一轮说的话：\n${clip(userText, MAX_USER)}\n\n助手这一轮的回复：\n${clip(assistantText, MAX_ASSISTANT)}\n\n动作清单（这一轮实际调用过的工具）：\n${actionText}`
    let out = ''
    try {
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 400,
        temperature: 0.2,
      })) {
        if (chunk.type === 'text-delta') out += chunk.text
        if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          throw new Error(chunk.reason.failure?.message ?? 'model error')
        }
      }
    } catch (error) {
      console.warn(`[dsh-work-log] 精简失败，改记原文：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    const text = out.trim()
    return text === '' ? undefined : clip(text, MAX_RECORD_CHARS)
  }

  function fallbackRecord(userText, assistantText) {
    return `用户要求：${clip(userText, 300)}\n结果：${clip(assistantText, 600)}`
  }

  /** 对话标题：标题服务优先，其次第一条用户消息。 */
  function titleOf(session, userText) {
    try {
      const snapshot = ctx.get('sessionTitle')?.get?.(session)
      if (typeof snapshot?.title === 'string' && snapshot.title.trim() !== '') return snapshot.title.trim()
    } catch {
      // 标题服务不可用：走兜底
    }
    const firstLine = String(userText ?? '').split('\n').find(line => line.trim() !== '')
    return firstLine === undefined ? undefined : clip(firstLine.trim(), 24)
  }

  async function writeJson(path, data) {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  }

  /** 找到这个会话应写入的文件；标题变化时把旧文件改名。 */
  async function locate(state, session, workspace, title) {
    const directory = join(settings.root, safeName(workspace, '未指定工作区'))
    const target = join(directory, `${safeName(title, '未命名对话')}.json`)

    if (state.file !== undefined && state.file !== target) {
      try {
        await rename(state.file, target)
        state.file = target
      } catch (error) {
        console.warn(`[dsh-work-log] 重命名日志失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (state.file === undefined) {
      const existing = await readFile(target, 'utf8').catch(() => undefined)
      if (existing !== undefined) {
        try {
          const parsed = JSON.parse(existing)
          if (parsed?.sessionId === state.id) {
            state.data = parsed
            state.file = target
            return state
          }
          // 同名文件属于别的会话：加短 id 区分
          state.file = join(directory, `${safeName(title, '未命名对话')}-${state.id.slice(-6)}.json`)
          state.data = undefined
          return state
        } catch {
          state.data = undefined
        }
      }
      state.file = target
      state.data = undefined
    }
    return state
  }

  async function recordTurn(session, turn, userText, assistantText, actions = []) {
    if (userText === '' && assistantText === '') return
    const state = stateOf(session)
    const workspace = basename(String(state.cwd ?? session.header?.cwd ?? '')) || '未指定工作区'
    const title = titleOf(session, userText) ?? '未命名对话'
    await locate(state, session, workspace, title)

    const llm = ctx.get('llm')
    const summary = settings.summarize && llm !== undefined
      ? await summarize(llm, userText, assistantText, actions)
      : undefined
    const content = summary ?? fallbackRecord(userText, assistantText)

    const now = new Date()
    const data = state.data ?? {
      generator: 'dsh-work-log',
      workspace,
      cwd: state.cwd ?? session.header?.cwd ?? null,
      conversation: title,
      sessionId: state.id,
      createdAt: stamp(now),
      updatedAt: stamp(now),
      records: [],
    }
    data.workspace = workspace
    data.cwd = state.cwd ?? session.header?.cwd ?? null
    data.conversation = title
    data.updatedAt = stamp(now)
    data.records.push(Object.assign(
      { index: data.records.length + 1, time: stamp(now), turn, content },
      actions.length > 0 ? { actions } : {},
    ))
    state.data = data
    await writeJson(state.file, data)
    console.info(`[dsh-work-log] 已记录 ${data.records.length} 条 → ${state.file}`)
  }

  function enqueue(state, work) {
    state.chain = state.chain.then(work).catch(error => {
      console.warn(`[dsh-work-log] 写入失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  ctx.on('session/event', (session, event) => {
    if (!settings.enabled) return
    if (session?.header?.origin === 'subagent') return
    try {
      const state = stateOf(session)
      if (event.type === 'user/message') {
        const text = textOf(event.data?.content)
        if (text !== '') state.users.push(text)
        state.assistants = []
        state.actions = []
        return
      }
      if (event.type === 'assistant/message') {
        const text = textOf(event.data?.message?.content)
        if (text !== '') state.assistants.push(text)
        return
      }
      if (event.type === 'tool/call') {
        const label = actionLabel(event.data?.name, event.data?.arguments)
        if (!state.actions.includes(label) && state.actions.length < 16) state.actions.push(label)
        return
      }
      if (event.type === 'turn/end') {
        if (event.data?.reason?.kind !== 'completed') return
        const userText = state.users.join('\n').trim()
        const assistantText = state.assistants.join('\n').trim()
        const actions = state.actions.slice()
        state.users = []
        state.assistants = []
        state.actions = []
        if (userText === '' && assistantText === '') return
        const turn = event.data?.turn ?? 0
        enqueue(state, () => recordTurn(session, turn, userText, assistantText, actions))
      }
    } catch (error) {
      console.warn(`[dsh-work-log] 事件处理失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/work-log/config',
      handler: async (req, res) => {
        if (!isLoopback(req.socket?.remoteAddress)) {
          sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
          return
        }
        if (req.method === 'GET') {
          sendJson(res, 200, { ok: true, version: PLUGIN_VERSION, root: settings.root, enabled: settings.enabled, summarize: settings.summarize, file: CONFIG_FILE })
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('allow', 'GET, POST')
          sendJson(res, 405, { ok: false, error: '只接受 GET / POST' })
          return
        }
        try {
          const patch = JSON.parse(await readBody(req))
          if (typeof patch?.root === 'string') {
            const root = patch.root.trim()
            if (root === '') throw new Error('根目录不能为空')
            settings.root = root
          }
          if (typeof patch?.enabled === 'boolean') settings.enabled = patch.enabled
          if (typeof patch?.summarize === 'boolean') settings.summarize = patch.summarize
          await mkdir(dirname(CONFIG_FILE), { recursive: true })
          await writeFile(CONFIG_FILE, `${JSON.stringify({ root: settings.root, enabled: settings.enabled, summarize: settings.summarize }, null, 2)}\n`, 'utf8')
          console.info(`[dsh-work-log] 根目录改为 ${settings.root}`)
          sendJson(res, 200, { ok: true, version: PLUGIN_VERSION, root: settings.root, enabled: settings.enabled, summarize: settings.summarize, file: CONFIG_FILE })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'dsh-work-log.config-route')
  }

  console.info(`[dsh-work-log] 已启用，根目录 ${settings.root}`)
}

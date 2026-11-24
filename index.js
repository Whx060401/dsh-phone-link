/**
 * Phone bridge: a private LAN page that hands work to this DSH and pushes each
 * finished result back to the phone.
 *
 * The plugin owns one dedicated DSH Session (created on the first message,
 * resumed afterwards), forwards phone prompts into its Agent inbox, and turns
 * the Session's own events into a small SSE protocol for the mobile page.
 * @module dsh-phone-bridge
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Official release the plugin downloads when no tunnel binary is present. */
const CLOUDFLARED_RELEASE_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'

/** QR encoder vendored from qrcode-generator (MIT, Kazuhiko Arase). */
const requireFromPlugin = createRequire(import.meta.url)
let qrEncoder
try {
  qrEncoder = requireFromPlugin('./vendor/qrcode-generator.cjs')
} catch {
  qrEncoder = undefined
}

/** Services this plugin cannot work without. */
export const inject = ['agents', 'sessions', 'sessionController']

/** Port used when the configuration states none. */
const DEFAULT_PORT = 8765

/** Largest accepted JSON request body. */
const MAX_BODY_BYTES = 64 * 1024

/** Largest accepted task text in Unicode code points. */
const MAX_TASK_CHARS = 8000

/** Characters used for a generated access token; no visually ambiguous pairs. */
const TOKEN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** Number of alternative ports tried when the preferred one is taken. */
const PORT_ATTEMPTS = 12

/** Load and validate the row configuration, applying documented defaults. */
function normalizeConfig(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const explicitPort = Number.isInteger(value.port) && value.port > 0 && value.port < 65536
  return {
    port: explicitPort ? value.port : DEFAULT_PORT,
    explicitPort,
    host: typeof value.host === 'string' && value.host.trim() !== '' ? value.host.trim() : '0.0.0.0',
    token: typeof value.token === 'string' && value.token.trim().length >= 12 ? value.token.trim() : undefined,
    cwd: typeof value.cwd === 'string' && value.cwd.trim() !== '' ? value.cwd.trim() : undefined,
    agentPreset: typeof value.agentPreset === 'string' && value.agentPreset.trim() !== ''
      ? value.agentPreset.trim()
      : undefined,
    title: typeof value.title === 'string' && value.title.trim() !== ''
      ? value.title.trim().slice(0, 120)
      : '手机遥控',
    tunnel: value.tunnel === true || (typeof value.tunnel === 'string' && value.tunnel.trim() !== '')
      ? value.tunnel
      : false,
    followActive: value.followActive !== false,
    sessionId: typeof value.sessionId === 'string' && value.sessionId.trim() !== ''
      ? value.sessionId.trim()
      : undefined,
  }
}

/** Directory holding this plugin's own small state file. */
function stateDirectory() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'phone-bridge')
}

/** Read the persisted state; a missing or unreadable file means no state. */
function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDirectory(), 'state.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Write the state file, merging one patch; failures never break the bridge. */
function writeState(state, patch) {
  Object.assign(state, patch)
  try {
    mkdirSync(stateDirectory(), { recursive: true })
    writeFileSync(join(stateDirectory(), 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    // A read-only home still allows the bridge to run with in-memory state.
  }
}

/** Mint one short, unambiguous access token. */
function mintToken() {
  const bytes = randomBytes(16)
  let token = ''
  for (const byte of bytes) token += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length]
  return token
}

/** Whether one IPv4 address is reachable only inside a private network. */
function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
}

/** Every non-internal IPv4 address the phone might reach, most likely first. */
function lanAddresses() {
  const found = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal) found.push(entry.address)
    }
  }
  const preferred = found.filter(isPrivateIPv4)
  const rank = address => (address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : 2)
  return [...new Set(preferred.sort((left, right) => rank(left) - rank(right)))]
}

/** Render one scannable QR code as a self-contained SVG, or '' without an encoder. */
function qrSvg(text, pixels) {
  if (qrEncoder === undefined) return ''
  let qr
  try {
    qr = qrEncoder(0, 'M')
    qr.addData(text, 'Byte')
    qr.make()
  } catch {
    return ''
  }
  const count = qr.getModuleCount()
  const margin = 4
  let path = ''
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (qr.isDark(row, column)) path += `M${column + margin},${row + margin}h1v1h-1z`
    }
  }
  const size = count + margin * 2
  return `<svg width="${pixels}" height="${pixels}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="手机页面二维码"><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`
}

/** Join the text blocks of one message content, ignoring other block kinds. */
function textOf(content) {  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += block.text
    }
  }
  return text
}

/** The newest assistant text recorded by one Session. */
function latestAssistantText(session) {
  let messages
  try {
    messages = session.deriveMessages()
  } catch {
    return ''
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const text = textOf(message.content)
    if (text.trim() !== '') return text
  }
  return ''
}

/** One browser-safe transcript row derived from the Session log. */
function historyOf(session) {
  let messages
  try {
    messages = session.deriveMessages()
  } catch {
    return []
  }
  const rows = []
  for (const message of messages) {
    if (message.role === 'user') {
      // Only prompts a human wrote; injected context and runtime notices stay out.
      if (message.source?.kind !== 'user') continue
      const text = textOf(message.content)
      if (text.trim() !== '') rows.push({ role: 'user', text: text.slice(0, 8000) })
    } else if (message.role === 'assistant') {
      const text = textOf(message.content)
      if (text.trim() !== '') rows.push({ role: 'assistant', text: text.slice(0, 8000) })
    }
  }
  return rows.slice(-40)
}

/** Constant-time token comparison over equal-length UTF-8 buffers. */
function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || candidate === '') return false
  const left = Buffer.from(candidate, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Register the bridge on one Host context.
 * @param ctx - plugin context carrying Agent, Session, and Session-controller services.
 * @param rawConfig - row configuration as written in the profile patch.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const state = loadState()
  const token = config.token
    ?? (typeof state.token === 'string' && state.token.length >= 16 ? state.token : mintToken())
  if (state.token !== token) writeState(state, { token })

  const logInfo = (message) => { try { ctx.logger?.info?.(`phone-bridge: ${message}`) } catch { /* logging is best effort */ } }
  const logWarn = (message) => { try { ctx.logger?.warn?.(`phone-bridge: ${message}`) } catch { /* logging is best effort */ } }
  const logError = (message) => { try { ctx.logger?.error?.(`phone-bridge: ${message}`) } catch { /* logging is best effort */ } }

  /** Read the mobile page from the package on every request, so edits apply without a reload. */
  function readPage() {
    return readFileSync(new URL('./public/index.html', import.meta.url), 'utf8')
  }

  /** Connected SSE responses. */
  const clients = new Set()
  /** DSH Session created by this plugin when no local Session can be followed. */
  let dedicatedSessionId = typeof state.sessionId === 'string' && state.sessionId !== '' ? state.sessionId : undefined
  /** Session the phone currently drives. */
  let targetSessionId
  /** Live Agent of that Session. */
  let agent
  /** In-flight Session resolution, shared by concurrent requests. */
  let ensuring
  /** Start time of the current turn, in epoch milliseconds. */
  let turnStartedAt = 0
  /** Outcome of the latest finished turn, served to polling phone pages. */
  let lastTurn = null
  /** Port the server actually bound, for the loopback link page. */
  let boundPort = 0
  /** Current public tunnel address, when the tunnel is running. */
  let publicUrl = ''
  /** Cloudflared child process, its restart timer, and teardown intent. */
  let tunnelChild
  let tunnelTimer
  let tunnelStopping = false

  const running = () => agent !== undefined && agent.status === 'running'
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
  const accessLogPath = join(stateDirectory(), 'access.log')

  /** Whether one request reached this server from the local machine itself. */
  function isLoopbackRequest(request) {
    const hostName = (request.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')
    return LOOPBACK.has(request.socket.remoteAddress ?? '')
      && (hostName === '127.0.0.1' || hostName === 'localhost' || hostName === '[::1]')
  }

  /** The DSH page origin, when it is a local Web GUI. */
  function loopbackOrigin(request) {
    const origin = request.headers.origin
    if (typeof origin !== 'string') return undefined
    return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin) ? origin : undefined
  }

  /** Link data for the DSH Web GUI panel. */
  function linkData() {
    const port = boundPort || config.port
    const publicLink = publicUrl === '' ? '' : `${publicUrl}/?k=${token}`
    const lanLinks = lanAddresses().map(address => {
      const link = `http://${address}:${port}/?k=${token}`
      return { link, qr: qrSvg(link, 160) }
    })
    return {
      ok: true,
      port,
      publicLink,
      publicQr: publicLink === '' ? '' : qrSvg(publicLink, 160),
      lanLinks,
      updatedAt: Date.now(),
    }
  }
  /** Optional cloudflared binary: true uses the downloaded copy, a string names another. */
  const tunnelBinary = config.tunnel === true
    ? join(stateDirectory(), 'bin', 'cloudflared.exe')
    : typeof config.tunnel === 'string' ? config.tunnel : undefined

  /** Start the public tunnel and remember its trycloudflare address. */
  function startTunnel() {
    if (tunnelStopping || tunnelChild !== undefined || tunnelBinary === undefined) return
    if (!existsSync(tunnelBinary)) {
      logWarn(`公网隧道未启动：找不到 ${tunnelBinary}`)
      return
    }
    const logFile = join(stateDirectory(), 'bin', 'tunnel.log')
    logInfo('正在启动公网隧道…')
    const child = spawn(tunnelBinary, [
      'tunnel', '--url', `http://127.0.0.1:${boundPort || config.port}`,
      '--no-autoupdate', '--protocol', 'http2', '--logfile', logFile,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    tunnelChild = child
    let buffered = ''
    const observe = chunk => {
      buffered += String(chunk)
      if (buffered.length > 64 * 1024) buffered = buffered.slice(-32 * 1024)
      const match = buffered.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (match !== null && publicUrl !== match[0]) {
        publicUrl = match[0]
        logInfo(`公网隧道：${publicUrl}`)
        logInfo(`在电脑浏览器打开 http://127.0.0.1:${boundPort || config.port}/link 复制公网手机链接`)
      }
    }
    child.stdout?.on('data', observe)
    child.stderr?.on('data', observe)
    child.on('error', error => { logError(`公网隧道进程错误：${String(error)}`) })
    child.on('exit', code => {
      if (tunnelChild !== child) return
      tunnelChild = undefined
      publicUrl = ''
      if (tunnelStopping) return
      logWarn(`公网隧道退出（code ${String(code)}），5 秒后重试`)
      tunnelTimer = setTimeout(() => {
        tunnelTimer = undefined
        startTunnel()
      }, 5000)
      tunnelTimer.unref?.()
    })
  }

  /** Stop the tunnel and cancel a pending restart. */
  function stopTunnel() {
    tunnelStopping = true
    if (tunnelTimer !== undefined) {
      clearTimeout(tunnelTimer)
      tunnelTimer = undefined
    }
    try {
      tunnelChild?.kill()
    } catch {
      // The child is already gone.
    }
    tunnelChild = undefined
    publicUrl = ''
  }

  /** Download the official cloudflared release on first use. */
  async function downloadTunnelBinary(destination) {
    mkdirSync(dirname(destination), { recursive: true })
    const temporary = `${destination}.download`
    logInfo('正在下载 cloudflared（约 55 MB，仅首次需要）…')
    const response = await fetch(CLOUDFLARED_RELEASE_URL, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20 * 60 * 1000),
    })
    if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary))
    const size = statSync(temporary).size
    if (size < 1024 * 1024) throw new Error(`下载文件过小（${size} 字节）`)
    renameSync(temporary, destination)
    logInfo(`cloudflared 已下载（${Math.round(size / 1024 / 1024)} MB）`)
  }

  /** Start the tunnel, downloading cloudflared first when it is missing. */
  async function ensureTunnel() {
    if (tunnelStopping || tunnelBinary === undefined) return
    if (!existsSync(tunnelBinary)) {
      try {
        await downloadTunnelBinary(tunnelBinary)
      } catch (error) {
        logWarn(`cloudflared 下载失败：${String(error)}；手机此时只能使用局域网地址`)
        return
      }
    }
    if (!tunnelStopping) startTunnel()
  }

  /** Record one non-loopback request, so a phone that cannot connect is diagnosable. */
  function recordAccess(request, url) {
    const remote = request.socket.remoteAddress ?? 'unknown'
    if (LOOPBACK.has(remote)) return
    try {
      if (statSync(accessLogPath).size > 512 * 1024) writeFileSync(accessLogPath, '')
    } catch {
      // The log does not exist yet.
    }
    try {
      appendFileSync(accessLogPath, `${new Date().toISOString()} ${remote} ${request.method ?? '-'} ${url.pathname}\n`)
    } catch {
      // A read-only home still serves the page.
    }
    logInfo(`远程访问 ${remote} ${request.method} ${url.pathname}`)
  }

  /** Render the loopback-only page that reveals the phone links and QR codes. */
  function linkPage() {
    const addresses = lanAddresses()
    const hosts = addresses.length === 0 ? ['127.0.0.1'] : addresses
    const port = boundPort || config.port
    const publicLink = publicUrl === '' ? '' : `${publicUrl}/?k=${token}`
    const lanLinks = hosts.map(host => `http://${host}:${port}/?k=${token}`)
    const item = (label, link, kind) => `<li${kind === '' ? '' : ` class="${kind}"`}><div class="meta">${label}</div><div class="line"><a href="${link}">${link}</a><button data-copy="${link}">复制</button></div></li>`
    const items = [
      ...(publicLink === '' ? [] : [item('公网地址 · 不需要同一网络', publicLink, 'public')]),
      ...lanLinks.map(link => item('局域网地址 · 仅同一 WiFi', link, '')),
    ].join('')
    const tunnelNote = publicLink === ''
      ? '<p class="warn">公网隧道还没就绪：插件正在启动它，或没有找到 cloudflared。</p>'
      : ''
    const primaryLink = publicLink === '' ? (lanLinks[0] ?? '') : publicLink
    const primaryLabel = publicLink === '' ? '局域网地址 · 仅同一 WiFi' : '公网地址 · 任何网络'
    const primaryQr = qrSvg(primaryLink, 230)
    const lanQr = publicLink !== '' && lanLinks.length > 0 ? qrSvg(lanLinks[0], 150) : ''
    const qrCards = primaryQr === ''
      ? ''
      : `<div class="qr-row">
  <div class="qr-card">
    <div class="meta">用微信「扫一扫」打开 · ${primaryLabel}</div>
    ${primaryQr}
  </div>
  ${lanQr === '' ? '' : `<div class="qr-card small"><div class="meta">同一 WiFi 可扫 · 局域网</div>${lanQr}</div>`}
</div>`
    return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>手机访问链接 · DSH 手机遥控</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 28px; background: #0d0f13; color: #e7ebf2; font: 15px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { color: #8b97a8; margin: 0 0 18px; max-width: 760px; }
  .warn { color: #ffb86b; }
  .qr-row { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; margin: 0 0 20px; }
  .qr-card { background: #fff; border-radius: 14px; padding: 12px; color: #333; }
  .qr-card .meta { color: #555; font-size: 12px; margin-bottom: 8px; }
  .qr-card svg { display: block; }
  .qr-card.small svg { width: 150px; height: 150px; }
  ul { list-style: none; padding: 0; max-width: 760px; }
  li { padding: 12px; margin-bottom: 10px; background: #141821; border: 1px solid #242b38; border-radius: 12px; }
  li.public { border-color: #33508a; }
  .meta { font-size: 12px; color: #8b97a8; margin-bottom: 6px; }
  .line { display: flex; align-items: center; gap: 10px; }
  a { color: #8ab4ff; text-decoration: none; word-break: break-all; flex: 1; }
  button { flex: none; border: 0; border-radius: 9px; background: #5b8cff; color: #fff; padding: 7px 12px; font: inherit; cursor: pointer; }
  .hint { font-size: 13px; color: #8b97a8; margin-top: 14px; }
</style>
<h1>手机访问链接</h1>
<p>手机微信「扫一扫」扫描下面的二维码即可打开；也可以复制任意一条链接。不在同一网络时用公网地址，公网地址每次重启会变化，以本页为准。</p>
${tunnelNote}
${qrCards}
<ul>${items}</ul>
<p class="hint">此页面只在本机（127.0.0.1）可见；链接里的令牌等同于密码，请勿发给别人。公网地址由 Cloudflare 隧道转发到本机 ${port} 端口，任务仍按本机 DSH 权限执行。</p>
<script>
  document.querySelectorAll('button[data-copy]').forEach(button => {
    button.addEventListener('click', async () => {
      const text = button.getAttribute('data-copy')
      try { await navigator.clipboard.writeText(text); button.textContent = '已复制' } catch { button.textContent = '请手动复制' }
    })
  })
</script>
</html>`
  }

  /** Write one SSE frame to every connected page. */
  function broadcast(event, data) {
    if (clients.size === 0) return
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const response of clients) {
      try {
        response.write(frame)
      } catch {
        clients.delete(response)
      }
    }
  }

  /** Send one SSE frame to one response. */
  function sendEvent(response, event, data) {
    try {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch {
      clients.delete(response)
    }
  }

  /** Human label for one live Session: its title, or a short identity. */
  function labelFor(target) {
    try {
      const title = ctx.get('sessionTitle')?.get(target.session)?.title
      if (typeof title === 'string' && title.trim() !== '') return title.trim()
    } catch {
      // A title failure must not break the bridge.
    }
    return `会话 ${target.id.slice(-6)}`
  }

  /** Adopt one live Agent as the phone target. */
  async function adopt(nextAgent, options = {}) {
    const changed = targetSessionId !== undefined && targetSessionId !== nextAgent.id
    agent = nextAgent
    targetSessionId = nextAgent.id
    if (changed) {
      lastTurn = null
      turnStartedAt = 0
    }
    if (options.dedicated === true) {
      const cwd = config.cwd ?? ctx.get('workingDirectory')?.defaultDirectory
      const registry = ctx.get('workspaceRegistry')
      if (registry !== undefined && typeof cwd === 'string' && cwd !== '') {
        try {
          const workspace = await registry.resolveByPath(cwd)
          await workspace?.attachSession(nextAgent.id)
        } catch (error) {
          logWarn(`session ${nextAgent.id} did not join its workspace: ${String(error)}`)
        }
      }
      const titles = ctx.get('sessionTitle')
      if (titles !== undefined) {
        try {
          if (titles.get(nextAgent.session) === undefined) titles.rename(nextAgent.session, config.title)
        } catch (error) {
          logWarn(`session ${nextAgent.id} was not titled: ${String(error)}`)
        }
      }
    }
    broadcast('hello', {
      sessionId: nextAgent.id,
      label: labelFor(nextAgent),
      title: config.title,
      running: running(),
    })
    return nextAgent
  }

  /** Resolve one stored Session to its live Agent. */
  async function resolveSessionAgent(sessionIdValue) {
    const found = await ctx.sessionController.resolveAgent(sessionIdValue)
    if ('error' in found) throw new Error(`无法打开会话：${found.error.message}`)
    return found.agent
  }

  /** The most recently used Session in a local workspace, if any. */
  async function newestSessionId() {
    let result
    try {
      result = await ctx.sessionController.list({}, new AbortController().signal)
    } catch {
      return undefined
    }
    const registry = ctx.get('workspaceRegistry')
    const archived = new Set(registry?.archivedSessionIds ?? [])
    // Sessions listed by a workspace are the ones the desktop sidebar shows;
    // the plugin's own fallback Session is never a follow target.
    const inWorkspace = new Set()
    for (const workspace of registry?.list() ?? []) {
      for (const workspaceSessionId of workspace.sessionIds) inWorkspace.add(workspaceSessionId)
    }
    const candidates = (result.items ?? [])
      .filter(item => item.origin !== 'subagent' && item.blank !== true && !archived.has(item.sessionId))
      .filter(item => item.sessionId !== dedicatedSessionId)
      .filter(item => inWorkspace.size === 0 || inWorkspace.has(item.sessionId))
      .sort((left, right) => right.updatedAt - left.updatedAt)
    return candidates[0]?.sessionId
  }

  /** Create (or resume) the plugin's own Session when nothing can be followed. */
  async function ensureDedicated() {
    if (dedicatedSessionId !== undefined) {
      try {
        return await resolveSessionAgent(dedicatedSessionId)
      } catch {
        dedicatedSessionId = undefined
        writeState(state, { sessionId: undefined })
      }
    }
    const cwd = config.cwd ?? ctx.get('workingDirectory')?.defaultDirectory ?? process.cwd()
    const created = await ctx.sessionController.create({
      cwd: resolve(cwd),
      ...(config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset }),
    })
    dedicatedSessionId = created.sessionId
    writeState(state, { sessionId: dedicatedSessionId })
    return resolveSessionAgent(dedicatedSessionId)
  }

  /**
   * Resolve the Session the phone drives. A configured `sessionId` pins one;
   * otherwise the most recently used Session in this workspace is followed, so
   * the phone works in the conversation already open on the computer. Only when
   * no local Session exists does the plugin create its own.
   */
  async function ensureTarget() {
    if (agent !== undefined && ctx.agents.get(agent.id) === agent) {
      if (config.sessionId === undefined && config.followActive) {
        const newest = await newestSessionId()
        if (newest !== undefined && newest !== targetSessionId) {
          try {
            return await adopt(await resolveSessionAgent(newest), { followed: true })
          } catch (error) {
            logWarn(`could not follow session ${newest}: ${String(error)}`)
          }
        }
      }
      return agent
    }
    agent = undefined
    if (ensuring !== undefined) return ensuring
    ensuring = (async () => {
      if (config.sessionId !== undefined) {
        return adopt(await resolveSessionAgent(config.sessionId), { followed: true })
      }
      if (config.followActive) {
        const newest = await newestSessionId()
        if (newest !== undefined) {
          try {
            return await adopt(await resolveSessionAgent(newest), { followed: true })
          } catch (error) {
            logWarn(`could not follow session ${newest}: ${String(error)}`)
          }
        }
      }
      return adopt(await ensureDedicated(), { dedicated: true })
    })().finally(() => { ensuring = undefined })
    return ensuring
  }

  /** Queue one phone task on the target Session and wait for its durable acknowledgment. */
  async function sendTask(text) {
    const target = await ensureTarget()
    if (target.status === 'running') {
      broadcast('notice', { text: '已加入队列，等当前这一步结束后开始' })
    }
    target.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    const flushed = await ctx.sessions.flush(target.session)
    if (!flushed) throw new Error('会话未确认写入')
  }

  // Durable Session events of the controlled Session drive the phone transcript.
  ctx.on('session/event', (session, event) => {
    if (agent === undefined || session !== agent.session) return
    switch (event.type) {
      case 'turn/start':
        turnStartedAt = Date.now()
        broadcast('status', { running: true, turn: event.data.turn })
        break
      case 'tool/call':
        broadcast('tool', { phase: 'start', name: event.data.name, callId: event.data.callId })
        break
      case 'tool/result': {
        const callId = event.data.message?.toolCallId
        broadcast('tool', {
          phase: 'end',
          ok: event.data.error === undefined,
          callId: typeof callId === 'string' ? callId : undefined,
        })
        break
      }
      case 'assistant/message': {
        const text = textOf(event.data.message?.content)
        if (text.trim() !== '') broadcast('step', { text })
        break
      }
      case 'turn/end': {
        const reason = event.data.reason ?? { kind: 'completed' }
        const elapsed = turnStartedAt === 0 ? 0 : Date.now() - turnStartedAt
        turnStartedAt = 0
        const payload = {
          phase: 'end',
          at: Date.now(),
          reason: reason.kind,
          text: latestAssistantText(session),
          ms: elapsed,
        }
        if (reason.kind === 'error' && typeof reason.error?.message === 'string') payload.message = reason.error.message
        lastTurn = payload
        broadcast('turn', payload)
        break
      }
      default:
        break
    }
  })

  // Live assistant tokens of the controlled Session become 'delta' frames.
  ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (agent === undefined || subject.session !== agent.session) return
    if (frame?.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk?.type === 'text-delta' && chunk.text !== '') broadcast('delta', { text: chunk.text })
  })

  // The DSH Web GUI panel reads the bridge port from this page global.
  ctx.on('webserver/index-inject', table => {
    table.push({
      kind: 'global',
      name: '__DSH_PHONE_BRIDGE__',
      value: { port: boundPort || config.port },
    })
  })

  /** Answer one HTTP request. */
  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://phone-bridge.invalid')
    const path = url.pathname
    recordAccess(request, url)

    if (request.method === 'GET' && path === '/ping') {
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      response.end('pong')
      return
    }

    if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
      let page
      try {
        page = readPage()
      } catch (error) {
        logError(`the mobile page could not be read: ${String(error)}`)
        sendJson(response, 500, { ok: false, error: 'page-missing' })
        return
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
      })
      response.end(page)
      return
    }

    if (request.method === 'GET' && path === '/favicon.ico') {
      response.writeHead(204)
      response.end()
      return
    }

    if (request.method === 'GET' && path === '/link') {
      const hostName = (request.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')
      const localHost = hostName === '127.0.0.1' || hostName === 'localhost' || hostName === '[::1]'
      // The loopback address alone is not enough once a tunnel forwards to it;
      // the Host header must also name this machine.
      if (!LOOPBACK.has(request.socket.remoteAddress ?? '') || !localHost) {
        response.writeHead(403, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        response.end('<!doctype html><meta charset="utf-8"><title>仅限本机</title><p>这个页面只能在电脑上打开：http://127.0.0.1:8765/link。手机请打开带 ?k= 的手机链接。</p>')
        return
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      })
      response.end(linkPage())
      return
    }

    if (path === '/api/link' && (request.method === 'GET' || request.method === 'OPTIONS')) {
      const headers = {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      }
      const origin = loopbackOrigin(request)
      if (origin !== undefined) {
        headers['access-control-allow-origin'] = origin
        headers.vary = 'Origin'
        headers['access-control-allow-methods'] = 'GET, OPTIONS'
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204, headers)
        response.end()
        return
      }
      if (!isLoopbackRequest(request)) {
        sendJson(response, 403, { ok: false, error: 'loopback-only' })
        return
      }
      sendJson(response, 200, linkData(), headers)
      return
    }

    if (!path.startsWith('/api/')) {
      sendJson(response, 404, { ok: false, error: 'not found' })
      return
    }

    const header = request.headers['x-phone-token']
    const fromHeader = Array.isArray(header) ? header[0] : header
    // EventSource cannot set headers, so a read may carry the token in the query.
    // State-changing requests must prove it through a header, so a leaked link
    // alone cannot drive the computer.
    const candidate = fromHeader ?? (request.method === 'GET' ? url.searchParams.get('k') : undefined)
    if (!tokenMatches(candidate, token)) {
      sendJson(response, 401, { ok: false, error: 'unauthorized', message: '访问令牌无效，请重新打开电脑上插件给出的链接。' })
      return
    }

    if (path === '/api/state' && request.method === 'GET') {
      let error
      if (agent === undefined) {
        // Opening the phone page resolves the Session it should show, so the
        // conversation already open on the computer appears here.
        try {
          await ensureTarget()
        } catch (failure) {
          error = String(failure?.message ?? failure)
        }
      }
      const active = agent !== undefined ? agent.session : undefined
      sendJson(response, 200, {
        ok: true,
        sessionId: targetSessionId ?? null,
        label: agent === undefined ? null : labelFor(agent),
        running: running(),
        title: config.title,
        history: active === undefined ? [] : historyOf(active),
        lastTurn,
        ...(error === undefined ? {} : { error }),
      })
      return
    }

    if (path === '/api/events' && request.method === 'GET') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-content-type-options': 'nosniff',
      })
      response.write('retry: 3000\n\n')
      clients.add(response)
      sendEvent(response, 'hello', {
        sessionId: targetSessionId ?? null,
        label: agent === undefined ? null : labelFor(agent),
        title: config.title,
        running: running(),
      })
      const heartbeat = setInterval(() => {
        try {
          response.write(': ping\n\n')
        } catch {
          clients.delete(response)
        }
      }, 20000)
      heartbeat.unref?.()
      const drop = () => {
        clearInterval(heartbeat)
        clients.delete(response)
      }
      // A reset socket raises 'error' on the response; without a listener that
      // becomes an uncaught exception in the Host process.
      response.on('error', drop)
      request.on('close', drop)
      return
    }

    if (path === '/api/send' && request.method === 'POST') {
      const body = await readJson(request)
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text === '') {
        sendJson(response, 400, { ok: false, error: 'empty', message: '请输入要交给 DSH 的任务。' })
        return
      }
      if ([...text].length > MAX_TASK_CHARS) {
        sendJson(response, 413, { ok: false, error: 'too-long', message: `任务最多 ${MAX_TASK_CHARS} 个字符。` })
        return
      }
      await sendTask(text)
      sendJson(response, 202, { ok: true })
      return
    }

    if (path === '/api/cancel' && request.method === 'POST') {
      if (agent !== undefined) {
        try {
          agent.cancel({ kind: 'user' })
        } catch (error) {
          logWarn(`cancel failed: ${String(error)}`)
        }
      }
      sendJson(response, 200, { ok: true, running: running() })
      return
    }

    sendJson(response, 404, { ok: false, error: 'not found' })
  }

  /** Read and parse one bounded JSON body. */
  async function readJson(request) {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    if (raw === '') return {}
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  }

  /** Create the HTTP server that owns every route. */
  function createBridgeServer() {
    return createServer((request, response) => {
      handle(request, response).catch((error) => {
        logWarn(`request failed: ${String(error)}`)
        if (!response.headersSent) {
          sendJson(response, 400, { ok: false, error: 'bad-request', message: String(error?.message ?? error) })
        } else {
          try {
            response.end()
          } catch {
            // The peer already closed the connection.
          }
        }
      })
    })
  }

  /** Bind the first free port from the preferred one upward. */
  async function listen(server, host, preferred) {
    let lastError
    for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
      const port = preferred + offset
      try {
        await new Promise((resolveListen, rejectListen) => {
          const onError = (error) => {
            server.off('listening', onListening)
            rejectListen(error)
          }
          const onListening = () => {
            server.off('error', onError)
            resolveListen()
          }
          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(port, host)
        })
        return port
      } catch (error) {
        lastError = error
        try {
          server.close()
        } catch {
          // Never-listened servers need no close.
        }
      }
    }
    throw lastError ?? new Error('没有可用端口')
  }

  ctx.effect(async () => {
    // An explicitly configured port always wins; a remembered port keeps the
    // bookmarked phone link stable across restarts.
    const preferred = config.explicitPort
      ? config.port
      : (Number.isInteger(state.port) ? state.port : config.port)
    const host = config.host
    const server = createBridgeServer()
    const bound = await listen(server, host, preferred)
    boundPort = bound
    writeState(state, { port: bound })
    if (bound !== config.port) {
      logWarn(`端口 ${config.port} 被占用，已改用 ${bound}；手机链接需要更新`)
    }
    const addresses = host === '0.0.0.0' || host === '::' ? lanAddresses() : [host]
    const links = (addresses.length === 0 ? ['127.0.0.1'] : addresses)
      .map(address => `http://${address}:${bound}/?k=${token}`)
    logInfo(`手机页面已启动（端口 ${bound}）`)
    logInfo(`在电脑浏览器打开 http://127.0.0.1:${bound}/link 查看并复制手机链接`)
    for (const link of links) logInfo(`手机访问：${link}`)
    if (tunnelBinary !== undefined) void ensureTunnel()

    return () => {
      stopTunnel()
      for (const response of clients) {
        try {
          response.end()
        } catch {
          // The peer already closed the connection.
        }
      }
      clients.clear()
      try {
        server.close()
      } catch {
        // Already closed.
      }
      logInfo('手机页面已停止')
    }
  })
}

/** Write one JSON response with the no-store policy every API shares. */
function sendJson(response, status, value, extra = {}) {
  if (response.headersSent) return
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extra,
  })
  response.end(body)
}

// dsh-tts — Host half.
//
// The browser page cannot call a third-party TTS endpoint directly (CORS), so
// the client asks this route instead: POST /dsh-tts/api { method, args }.
//
//   speak: { text, endpoint, apiKey, model, voice, speed, format }
//     -> POST <endpoint>/audio/speech with the OpenAI-compatible body
//        { model, input, voice, speed, response_format }
//     -> { ok: true, audio: <base64>, mime }
//
// Design notes:
//   * Config persists host-side at ~/.dsh/tts-config.json (get-config /
//     save-config below): detached windows / new WebView2 instances each have
//     their own localStorage, so browser storage made every new window look
//     "unconfigured". localStorage stays only as a render cache. Note this
//     means the API key lands in that file (same area as .credentials.yaml).
//   * Errors are reported, never thrown: the client renders the reason.
//   * A 60 s timeout guards the upstream call.
import { Service } from '@deepseek-ai/cordis'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const ROUTE_PATH = '/dsh-tts/api'
const UPSTREAM_TIMEOUT_MS = 60000
const MAX_CHARS = 20000           // 单次合成上限；客户端会先分块
const CONFIG_FILE = path.join(os.homedir(), '.dsh', 'tts-config.json')
const KNOWN_KEYS = ['endpoint', 'apiKey', 'model', 'voice', 'speed', 'format', 'auto', 'autoScope']
const LIMITS = { endpoint: 300, apiKey: 400, model: 100, voice: 100, format: 20 }

function sanitizeConfig(value) {
  if (!value || typeof value !== 'object') return null
  const clean = {}
  for (const key of KNOWN_KEYS) {
    if (value[key] === undefined) continue
    const limit = LIMITS[key]
    clean[key] = limit !== undefined ? String(value[key]).slice(0, limit) : value[key]
  }
  return clean
}

function readConfigFile() {
  try { return sanitizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))) } catch { return null }
}

function writeConfigFile(value) {
  const clean = sanitizeConfig(value)
  if (!clean) return false
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2))
    return true
  } catch { return false }
}

export class TtsService extends Service {
  static inject = ['webServer']

  constructor(ctx) {
    super(ctx, 'tts')
  }

  async [Service.init]() {
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (req, res) => this.handleApi(req, res),
    }))
  }

  async handleApi(req, res) {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST') { send(405, { ok: false, reason: 'method-not-allowed' }); return }
    let raw = ''
    try { for await (const chunk of req) raw += chunk } catch { send(400, { ok: false, reason: 'read-failed' }); return }
    let request = null
    try { request = JSON.parse(raw) } catch { send(400, { ok: false, reason: 'bad-json' }); return }
    const method = request && typeof request.method === 'string' ? request.method : ''
    try {
      if (method === 'speak') { send(200, await this.speak(request.args || {})); return }
      if (method === 'get-config') { send(200, { ok: true, config: readConfigFile() }); return }
      if (method === 'save-config') {
        const saved = writeConfigFile(request.args && request.args.config)
        send(200, { ok: saved, reason: saved ? undefined : 'write-failed' })
        return
      }
      send(200, { ok: false, reason: 'unknown-method: ' + method })
    } catch (error) {
      send(200, { ok: false, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  /** endpoint 规范化：允许填 base（…/v1）或完整路径（…/audio/speech）。 */
  speechUrl(endpoint) {
    let base = String(endpoint || '').trim().replace(/\/+$/, '')
    if (base === '') throw new Error('未配置 TTS 接口地址')
    if (!/^https?:\/\//.test(base)) throw new Error('接口地址必须是 http(s) URL')
    if (!/\/audio\/speech$/.test(base)) base += '/audio/speech'
    return base
  }

  async speak(args) {
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (text === '') return { ok: false, reason: 'empty-text' }
    if (text.length > MAX_CHARS) return { ok: false, reason: 'text-too-long: ' + text.length + '>' + MAX_CHARS }
    /* 宿主持久配置兜底：客户端（尤其是没配置过的手机端）缺字段时用存储值补齐。
       客户端显式传的非空值优先——允许某窗口临时换音色而不动全局配置。 */
    const stored = readConfigFile() || {}
    const pick = (v, d) => { const t = typeof v === 'string' ? v.trim() : ''; return t !== '' ? t : (d !== undefined && d !== null ? String(d) : '') }
    let url
    try { url = this.speechUrl(pick(args.endpoint, stored.endpoint)) } catch (error) { return { ok: false, reason: error.message } }
    const body = {
      model: pick(args.model, stored.model || 'tts-1'),
      input: text,
      voice: pick(args.voice, stored.voice || 'alloy'),
      response_format: pick(args.format, stored.format || 'mp3'),
    }
    const rawSpeed = args.speed !== undefined && args.speed !== null && String(args.speed).trim() !== '' ? Number(args.speed) : Number(stored.speed)
    const speed = Number.isFinite(rawSpeed) ? rawSpeed : 1
    if (speed >= 0.25 && speed <= 4 && speed !== 1) body.speed = speed
    const headers = { 'content-type': 'application/json' }
    const apiKey = pick(args.apiKey, stored.apiKey)
    if (apiKey !== '') headers.authorization = 'Bearer ' + apiKey

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
    let res
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
    } catch (error) {
      const reason = error && error.name === 'AbortError' ? 'upstream-timeout' : 'upstream-error: ' + (error && error.message ? error.message : String(error))
      return { ok: false, reason }
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      let detail = ''
      try { detail = (await res.text()).slice(0, 300) } catch { /* ignore */ }
      return { ok: false, reason: 'upstream-' + res.status + (detail ? ': ' + detail : '') }
    }
    const mime = res.headers.get('content-type') || 'audio/mpeg'
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) return { ok: false, reason: 'upstream-empty-audio' }
    return { ok: true, audio: buf.toString('base64'), mime, bytes: buf.length }
  }
}

export default TtsService

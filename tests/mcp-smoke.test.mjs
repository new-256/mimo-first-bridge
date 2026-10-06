// tests/mcp-smoke.test.mjs — spawn mimo-mcp-server --check and a fake MCP handshake.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = join(root, 'mcp', 'mimo-mcp-server.mjs')

function runCheck() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server, '--check'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    child.on('close', (code) => {
      if (code === 0 && out.includes('mimo_run') && out.includes('check ok')) resolve(out)
      else reject(new Error('check failed code=' + code + '\n' + out))
    })
    child.on('error', reject)
  })
}

function handshake() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    const msgs = []
    child.stdout.on('data', (c) => {
      out += c
      for (const line of out.split('\n')) {
        if (!line.trim()) continue
        try { msgs.push(JSON.parse(line)) } catch (e) {}
      }
    })
    child.on('error', reject)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
    setTimeout(() => {
      child.kill()
      try {
        const init = msgs.find((m) => m.id === 1)
        const list = msgs.find((m) => m.id === 2)
        assert.ok(init && init.result && init.result.serverInfo, 'initialize result')
        assert.ok(list && list.result && Array.isArray(list.result.tools), 'tools/list result')
        const names = list.result.tools.map((t) => t.name).sort()
        assert.deepEqual(names, ['mimo_continue', 'mimo_run', 'mimo_settings', 'mimo_status'])
        console.log('ok: MCP handshake initialize + tools/list')
        resolve()
      } catch (e) { reject(e) }
    }, 500)
  })
}

const out = await runCheck()
assert.ok(out.includes('check ok'))
console.log('ok: mimo-mcp-server --check')

await handshake()
console.log('mcp smoke tests passed')

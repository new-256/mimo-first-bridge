// tests/contracts.test.mjs — DSH plugin contract locks (mirror verify.mjs).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const pkg = JSON.parse(read('package.json'))
const clientSrc = read('home-plugin/mimo-indicator/lib/client.js')

// THE contract that crashed agy/codebuddy when violated:
const reg = clientSrc.match(/__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]*?id:\s*["']([^"']+)["']/)
assert.ok(reg, 'client.js must call __ModuleLoader__.load')
assert.equal(reg[1], pkg.name, 'client module id MUST equal package name, got ' + reg[1])
assert.notEqual(reg[1], 'mimo-indicator', 'must NOT use inner package name')

assert.equal(pkg.main, './home-plugin/mimo-indicator/lib/index.mjs')
assert.equal(pkg.dsh.bundle.patch, './home-plugin/mimo-indicator/cordis.patch.yml')
assert.equal(pkg.dsh.client.platform, 'web')

const bridge = read('preset/mimo-first/mimo-first-bridge.mjs')
assert.ok(bridge.includes("name: 'mimo_run'"))
assert.ok(bridge.includes("name: 'mimo_continue'"))
assert.ok(bridge.includes("name: 'mimo_status'"))
assert.ok(bridge.includes("name: 'mimo_settings'"))
assert.ok(bridge.includes("mimo:policy"))
assert.ok(bridge.includes('loadRuntime'))
assert.ok(bridge.includes('backend'))

const cordis = read('preset/mimo-first/agent.cordis.yml')
assert.ok(/^- id: mimo-first-bridge$/m.test(cordis))
assert.ok(cordis.includes("name: './mimo-first-bridge.mjs'"))
assert.ok(cordis.includes('workflow-ptc'))
assert.ok(cordis.includes('workflow-worker-thread'))

const mcp = read('mcp/mimo-mcp-server.mjs')
assert.ok(mcp.includes("const VERSION = '" + pkg.version + "'"))
assert.ok(mcp.includes('mimo_run'))
assert.ok(mcp.includes('mimo_continue'))
assert.ok(mcp.includes('mimo_status'))
assert.ok(mcp.includes('mimo_settings'))
assert.ok(mcp.includes('BACKENDS'))

const rt = read('core/runtime-settings.mjs')
assert.ok(rt.includes('MIMO_BRIDGE_BACKEND'))
assert.ok(rt.includes('mimo-first-bridge'))
assert.ok(rt.includes('desktop-api.json'))

console.log('ok: contracts (client id, package shape, tools, workflow dual-row, mcp version, backend settings)')

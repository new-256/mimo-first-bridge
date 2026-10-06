#!/usr/bin/env node
// scripts/build.mjs — sync derived artifacts from core/mimo-core.mjs.
//
// Derived:
//   preset/mimo-first/mimo-core.mjs   (byte copy of core/mimo-core.mjs)
//
// Usage:
//   node scripts/build.mjs           # write derived artifacts
//   node scripts/build.mjs --check   # verify derived == source (CI / npm test)

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')

const CORE = join(root, 'core', 'mimo-core.mjs')
const PRESET_CORE = join(root, 'preset', 'mimo-first', 'mimo-core.mjs')
const RT = join(root, 'core', 'runtime-settings.mjs')
const PRESET_RT = join(root, 'preset', 'mimo-first', 'runtime-settings.mjs')

function norm(s) { return String(s).replace(/\r\n/g, '\n') }

let failed = false
function checkEq(label, a, b) {
  if (norm(a) === norm(b)) console.log('ok: ' + label)
  else { console.error('FAIL: ' + label); failed = true }
}

const coreSrc = readFileSync(CORE, 'utf8')
const rtSrc = readFileSync(RT, 'utf8')

if (check) {
  if (!existsSync(PRESET_CORE)) {
    console.error('FAIL: preset/mimo-first/mimo-core.mjs missing (run node scripts/build.mjs)')
    process.exit(1)
  }
  if (!existsSync(PRESET_RT)) {
    console.error('FAIL: preset/mimo-first/runtime-settings.mjs missing (run node scripts/build.mjs)')
    process.exit(1)
  }
  checkEq('preset/mimo-first/mimo-core.mjs === core/mimo-core.mjs', coreSrc, readFileSync(PRESET_CORE, 'utf8'))
  checkEq('preset/mimo-first/runtime-settings.mjs === core/runtime-settings.mjs', rtSrc, readFileSync(PRESET_RT, 'utf8'))
  process.exit(failed ? 1 : 0)
}

copyFileSync(CORE, PRESET_CORE)
console.log('wrote preset/mimo-first/mimo-core.mjs')
copyFileSync(RT, PRESET_RT)
console.log('wrote preset/mimo-first/runtime-settings.mjs')
console.log('build ok')

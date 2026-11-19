// The local replica the e2e tests run against, as e2e/setup.sh left it

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

export const env = JSON.parse(
  readFileSync(path.join(here, 'env.json'), 'utf8')
) as {
  url: string // the e2e build
  real_url: string // the normal build
  backend: string
  stub: string
  identity: string
}
if (!env.real_url)
  throw new Error('e2e/env.json is from an older setup: run e2e/setup.sh again')

export function icp(...args: string[]): string {
  return execFileSync(
    'icp',
    [...args, '--environment', 'local', '--identity', env.identity],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }
  )
}

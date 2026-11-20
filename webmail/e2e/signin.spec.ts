// The real sign-in, through the Internet Identity that a local network with
// `ii: true` serves at id.ai.localhost, on the normal webmail build. The other
// specs use the e2e build, whose fixed keys skip all of this.

import { expect, test } from '@playwright/test'
import { env, icp } from './local'

test('a user signs in through the local Internet Identity', async ({
  page,
}) => {
  await page.goto(env.real_url)
  const popup = page.waitForEvent('popup')
  await page
    .getByRole('button', { name: 'Sign in with Internet Identity' })
    .click()
  const ii = await popup
  // The screens of the Internet Identity that icp-cli 1.8.0 serves. The local
  // Internet Identity asks for a seed index in place of a passkey.
  // An index can create only one identity on a network, so each run takes
  // its own.
  const seed = String(Date.now())
  ii.on('dialog', (dialog) => dialog.accept(seed))
  await ii.getByRole('button', { name: 'Create', exact: true }).click()
  await ii.getByRole('button', { name: 'Create with passkey' }).click()
  await ii.getByRole('textbox', { name: 'Identity name' }).fill('Test')
  await ii.getByRole('button', { name: 'Create identity' }).click()
  await ii.getByRole('button', { name: 'Continue', exact: true }).click()

  // The backend answered a call signed with the delegation, which needs the
  // local network's root key
  await expect(
    page.getByRole('heading', { name: 'Not activated yet' })
  ).toBeVisible()
  const principal = (await page.getByTestId('principal').textContent()) ?? ''
  expect(principal).toMatch(/^[a-z0-9-]{20,}$/)

  // A controller of the backend gets the Admin panel
  icp(
    'canister',
    'settings',
    'update',
    'email-canister-test',
    '--add-controller',
    principal
  )
  let removal: unknown
  try {
    await page.reload()
    // In the header's menu
    await page.getByLabel('More', { exact: true }).click()
    await expect(page.getByRole('button', { name: 'Admin' })).toBeVisible()
  } finally {
    try {
      icp(
        'canister',
        'settings',
        'update',
        'email-canister-test',
        '--remove-controller',
        principal
      )
    } catch (error) {
      console.error(`${principal} is still a controller:`, error)
      removal = error
    }
  }
  // Reached only when the test passed, so a failed test keeps its own error
  if (removal !== undefined) throw removal
})

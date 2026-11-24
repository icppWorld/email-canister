// The address a calendar app is handed, apart from the calendar's serial
// browser tests: it needs no backend

import { expect, test } from '@playwright/test'

import { subscribeUrl } from '../src/ical'

test('a calendar app is handed the address with TLS kept', () => {
  expect(subscribeUrl('https://a.icp0.io/cal/t.ics')).toBe(
    'webcals://a.icp0.io/cal/t.ics'
  )
  // The local network has no TLS
  expect(subscribeUrl('http://a.localhost:8000/cal/t.ics')).toBe(
    'webcal://a.localhost:8000/cal/t.ics'
  )
})

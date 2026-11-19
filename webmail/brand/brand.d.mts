// Types for brand.mjs, which stays plain JavaScript so deployments can run it
// with Node.js alone

export type Logo = { light: string; dark: string; alt: string }
export type Brand = {
  name: string
  label: string
  tagline: string
  logo: Logo | null
}
export type Loaded = {
  brand: Brand
  links: string[]
  outputs: Map<string, Buffer | string>
  warnings: string[]
}
export type Settings = {
  backend: string
  network: 'ic' | 'local'
  derivationOrigin: string | null
}

export class BrandError extends Error {}
export const TYPES: Record<string, string>
export function escapeHtml(text: string): string
export function contrast(a: string, b: string): number | null
export function loadBrand(folder: string | undefined): Loaded
export function checkSettings(options: {
  backend?: string
  network?: string
  origin?: string
}): Settings
export function applyToHtml(
  html: string,
  loaded: Loaded,
  settings: Settings
): string
export function writeWebmail(options: {
  dist: string
  out: string
  brand?: string
  backend?: string
  network?: string
  origin?: string
  customDomains?: string[]
}): Loaded

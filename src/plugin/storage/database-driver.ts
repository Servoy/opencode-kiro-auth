import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let DatabaseImpl: any

const isBun = typeof globalThis.Bun !== 'undefined'

if (isBun) {
  DatabaseImpl = require('bun:sqlite').Database
} else {
  DatabaseImpl = require('node:sqlite').DatabaseSync
}

export interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

export interface SqliteStatement {
  run(...params: any[]): any
  get(...params: any[]): any
  all(...params: any[]): any[]
}

export function openDatabase(path: string, options?: { readonly?: boolean }): SqliteDatabase {
  if (isBun) {
    return new DatabaseImpl(path, options?.readonly ? { readonly: true } : undefined)
  }
  const opts: any = {}
  if (options?.readonly) opts.readOnly = true
  return new DatabaseImpl(path, opts)
}

/**
 * Postgres middleware.
 *
 * Node/Deno-only — this uses `pg` and does not run on Workers/edge.
 *
 * @packageDocumentation
 */

export type { FetchHandler } from '../../core/index.js'
export { withPostgres } from './with-postgres.js'
export type { PostgresConfig, Postgres } from './with-postgres.js'
export type { Db } from './db.js'

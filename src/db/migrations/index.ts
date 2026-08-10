import type { Migration } from '../migrate.js'
import { initial } from './0001-initial.js'
import { syncEngine } from './0002-sync-engine.js'
import { llmCalls } from './0003-llm-calls.js'
import { classification } from './0004-classification.js'

/**
 * Every migration, in order. Listed explicitly rather than discovered from the filesystem:
 * an explicit array survives the build to `dist/` unchanged and cannot pick up a stray
 * file, and a new migration is one import and one line.
 */
export const migrations: readonly Migration[] = [initial, syncEngine, llmCalls, classification]

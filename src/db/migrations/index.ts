import type { Migration } from '../migrate.js'
import { initial } from './0001-initial.js'
import { syncEngine } from './0002-sync-engine.js'
import { llmCalls } from './0003-llm-calls.js'
import { classification } from './0004-classification.js'
import { calendarAndPlans } from './0005-calendar-and-plans.js'
import { chat } from './0006-chat.js'
import { backupSources } from './0007-backup-sources.js'
import { previousStatus } from './0008-previous-status.js'
import { settings } from './0009-settings.js'
import { turnContext } from './0010-turn-context.js'
import { sessions } from './0011-sessions.js'

/**
 * Every migration, in order. Listed explicitly rather than discovered from the filesystem:
 * an explicit array survives the build to `dist/` unchanged and cannot pick up a stray
 * file, and a new migration is one import and one line.
 */
export const migrations: readonly Migration[] = [
  initial,
  syncEngine,
  llmCalls,
  classification,
  calendarAndPlans,
  chat,
  backupSources,
  previousStatus,
  settings,
  turnContext,
  sessions,
]

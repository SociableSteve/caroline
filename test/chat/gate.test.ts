import { describe, expect, it } from 'vitest'
import { describeCall } from '../../src/chat/gate.js'
import type { ChatToolContext } from '../../src/chat/types.js'

// The fallback path never reads `context`, `create_task` and `update_task` have no `describe` of
// their own, so this exercises exactly the branch a titled write tool without one falls into.
const context = {} as ChatToolContext

describe('describeCall', () => {
  it('names a titled tool without a custom describe by its title, in curly quotes', () => {
    const tool = { name: 'create_task' }
    const call = { arguments: { title: 'Renew the certificate' } }

    expect(describeCall(context, tool, call)).toBe('create_task: “Renew the certificate”')
  })
})

import { describe, expect, it } from 'vitest'
import { isStrictCompatible } from '../../../src/llm/adapters/strict-schema.js'
import { classificationSchema } from '../../helpers/llm.js'

describe('deciding whether OpenAI strict mode can be used', () => {
  it('accepts a closed object with every property required', () => {
    expect(isStrictCompatible(classificationSchema)).toBe(true)
  })

  it('refuses an object that allows extra properties', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        required: ['status'],
        properties: { status: { type: 'string' } },
      }),
    ).toBe(false)
  })

  it('refuses an object with an optional property', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        additionalProperties: false,
        required: [],
        properties: { status: { type: 'string' } },
      }),
    ).toBe(false)
  })

  it('refuses a nested object that would fail on its own', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        additionalProperties: false,
        required: ['task'],
        properties: {
          task: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        },
      }),
    ).toBe(false)
  })

  it('looks inside array items', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        additionalProperties: false,
        required: ['tasks'],
        properties: {
          tasks: {
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'string' } } },
          },
        },
      }),
    ).toBe(false)
  })

  it('accepts a schema with no objects in it at all', () => {
    expect(isStrictCompatible({ type: 'array', items: { type: 'string' } })).toBe(true)
  })
})

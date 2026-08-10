import { describe, expect, it } from 'vitest'
import { isStrictCompatible } from '../../../src/llm/adapters/strict-schema.js'
import { classificationSchema } from '../../helpers/llm.js'

describe('deciding whether OpenAI strict mode can be used', () => {
  it('accepts a closed object whose every property is required', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        additionalProperties: false,
        required: ['status'],
        properties: { status: { type: 'string', enum: ['inbox', 'next'] } },
      }),
    ).toBe(true)
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

  it('walks every entry of a tuple, not just the first', () => {
    expect(
      isStrictCompatible({
        type: 'array',
        items: [
          { type: 'string' },
          { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        ],
      }),
    ).toBe(false)
  })

  it('looks inside $defs, which a $ref reaches into', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        additionalProperties: false,
        required: ['task'],
        properties: { task: { $ref: '#/$defs/task' } },
        $defs: { task: { type: 'object', properties: { id: { type: 'string' } } } },
      }),
    ).toBe(false)
  })

  /**
   * An allowlist, so a keyword nobody here has considered lands on the unstrict side. The
   * two failure modes are not symmetric: unstrict costs a guarantee validation supplies
   * anyway, while strict with an unsupported keyword fails the whole request.
   */
  it.each([
    ['oneOf', { oneOf: [{ type: 'string' }] }],
    ['allOf', { allOf: [{ type: 'string' }] }],
    ['not', { not: { type: 'string' } }],
    ['if', { if: { type: 'string' }, then: { type: 'number' } }],
    ['patternProperties', { type: 'object', patternProperties: {} }],
    ['pattern', { type: 'string', pattern: '^a' }],
    ['format', { type: 'string', format: 'date-time' }],
    ['minLength', { type: 'string', minLength: 1 }],
    ['minimum', { type: 'number', minimum: 0 }],
    ['minItems', { type: 'array', minItems: 1 }],
  ])('refuses a schema using %s, which is outside the supported subset', (_keyword, schema) => {
    expect(isStrictCompatible(schema)).toBe(false)
  })

  it('refuses a keyword nested inside a property, not only one at the root', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        additionalProperties: false,
        required: ['confidence'],
        properties: { confidence: { type: 'number', minimum: 0, maximum: 1 } },
      }),
    ).toBe(false)
  })

  /**
   * A union type is not read as an object, so the object rules would be skipped for
   * something that can still be one. Refused rather than half-checked.
   */
  it('refuses a union type', () => {
    expect(isStrictCompatible({ type: ['object', 'null'] })).toBe(false)
  })

  /**
   * A recognised keyword holding nonsense is malformed rather than unsupported, but it is no
   * more sendable for that. Checking names alone would wave these through on the grounds
   * that the keyword is one the table knows about.
   */
  it.each([
    ['$ref', { $ref: 1 }],
    ['properties', { properties: 1 }],
    ['properties holding a non-schema', { type: 'object', properties: { id: 1 } }],
    ['$defs', { $defs: 1 }],
    ['items', { items: 1 }],
    ['items in tuple form', { type: 'array', items: [1] }],
    ['anyOf', { anyOf: [1] }],
    ['an empty anyOf', { anyOf: [] }],
    ['required', { required: [1] }],
    ['additionalProperties', { type: 'object', additionalProperties: {} }],
    ['enum', { enum: 'next' }],
    ['description', { description: 1 }],
  ])('refuses a malformed %s, not only an unrecognised keyword', (_keyword, schema) => {
    expect(isStrictCompatible(schema as Record<string, unknown>)).toBe(false)
  })

  it('accepts anyOf, which is the one composition keyword strict mode supports', () => {
    expect(isStrictCompatible({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBe(true)
  })

  it('accepts a schema with no objects in it at all', () => {
    expect(isStrictCompatible({ type: 'array', items: { type: 'string' } })).toBe(true)
  })

  /**
   * Caroline's own classification schema constrains `confidence` to 0..1, which is outside
   * the supported subset, so it is sent unstrict. The range is still enforced: the shared
   * validator applies the whole schema whichever mode the request went out in.
   */
  it('sends the classification schema unstrict, because of its numeric bounds', () => {
    expect(isStrictCompatible(classificationSchema)).toBe(false)
  })
})

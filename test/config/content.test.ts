import { describe, expect, it } from 'vitest'
import {
  contentAtLevel,
  contentToStore,
  levelAllows,
  lowerLevel,
  purgedContent,
} from '../../src/config/content.js'

const body = 'Could you take a look at the hub numbers before Thursday? Ta, Sam'

describe('the content a level permits', () => {
  it('is nothing at all at none', () => {
    expect(contentAtLevel(body, 'none', 300)).toBeNull()
  })

  it('is nothing at all at metadata, which is what "no bodies at rest" means', () => {
    expect(contentAtLevel(body, 'metadata', 300)).toBeNull()
  })

  it('is the first snippetChars at snippet', () => {
    expect(contentAtLevel(body, 'snippet', 20)).toBe('Could you take a loo')
  })

  it('is the whole body at snippet when the body is shorter than the cap', () => {
    expect(contentAtLevel(body, 'snippet', 300)).toBe(body)
  })

  it('is the whole body at full', () => {
    expect(contentAtLevel(body, 'full', 20)).toBe(body)
  })

  it('is null for an item that has no body, at every level', () => {
    expect(contentAtLevel(null, 'full', 300)).toBeNull()
    expect(contentAtLevel('', 'full', 300)).toBeNull()
    expect(contentAtLevel(undefined, 'snippet', 300)).toBeNull()
  })

  it('truncates by characters, because the cap is a disclosure limit and not a layout', () => {
    expect(contentAtLevel(body, 'snippet', 5)).toBe('Could')
    expect(contentAtLevel(body, 'snippet', 7)).toBe('Could y')
  })
})

describe('comparing levels', () => {
  it('reports whether one permits at least as much as another', () => {
    expect(levelAllows('snippet', 'metadata')).toBe(true)
    expect(levelAllows('snippet', 'snippet')).toBe(true)
    expect(levelAllows('metadata', 'snippet')).toBe(false)
  })

  it('picks the lower of two', () => {
    expect(lowerLevel('full', 'snippet')).toBe('snippet')
    expect(lowerLevel('none', 'metadata')).toBe('none')
    expect(lowerLevel('snippet', 'snippet')).toBe('snippet')
  })
})

describe('the store boundary', () => {
  it('writes no content at all under the default policy', () => {
    expect(contentToStore(body, { storeContent: 'metadata', snippetChars: 300 })).toEqual({
      content: null,
      level: 'metadata',
    })
  })

  it('records the level the body was written under, not the shape of the text', () => {
    expect(contentToStore('Short', { storeContent: 'full', snippetChars: 300 })).toEqual({
      content: 'Short',
      level: 'full',
    })
  })
})

describe('purging content the policy no longer allows', () => {
  const policy = { storeContent: 'metadata', snippetChars: 300 } as const

  it('clears a body stored under a higher level', () => {
    expect(purgedContent(body, 'full', policy)).toEqual({ content: null, level: 'metadata' })
  })

  it('cuts a full body back to a snippet when the policy is now snippet', () => {
    expect(purgedContent(body, 'full', { storeContent: 'snippet', snippetChars: 10 })).toEqual({
      content: 'Could you ',
      level: 'snippet',
    })
  })

  it('leaves a row alone when the policy still allows what it holds', () => {
    expect(purgedContent(body, 'snippet', { storeContent: 'full', snippetChars: 300 })).toBeNull()
    expect(purgedContent(null, 'metadata', policy)).toBeNull()
  })
})

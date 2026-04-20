import { describe, expect, test } from 'bun:test'
import { chunk, parsePost, safeName, extractImageKeys } from '../src/feishu.ts'

describe('chunk', () => {
  test('short text returns as single chunk', () => {
    expect(chunk('hi', 100, 'length')).toEqual(['hi'])
  })

  test('splits by length when no boundaries (mode=length)', () => {
    const parts = chunk('a'.repeat(12000), 5000, 'length')
    expect(parts.length).toBe(3)
    expect(parts[0]!.length).toBe(5000)
    expect(parts[1]!.length).toBe(5000)
    expect(parts[2]!.length).toBe(2000)
  })

  test('prefers paragraph boundary when mode=newline', () => {
    const src = 'a'.repeat(3000) + '\n\n' + 'b'.repeat(3000) + '\n\n' + 'c'.repeat(3000)
    const parts = chunk(src, 5000, 'newline')
    expect(parts.length).toBeGreaterThanOrEqual(2)
    expect(parts[0]!).toMatch(/^a+$/)
  })

  test('falls back to single-newline when no paragraph boundary available', () => {
    const line = 'a'.repeat(2400)
    const src = [line, line, line].join('\n')
    const parts = chunk(src, 5000, 'newline')
    expect(parts.length).toBeGreaterThanOrEqual(2)
    // first chunk should not split mid-line
    expect(parts[0]!.endsWith('a')).toBe(true)
  })

  test('empty string returns []', () => {
    expect(chunk('', 5000, 'length')).toEqual([])
  })

  test('text exactly at limit is one chunk', () => {
    expect(chunk('x'.repeat(5000), 5000, 'length').length).toBe(1)
  })
})

describe('parsePost', () => {
  test('text msg_type → text field', () => {
    expect(parsePost('text', '{"text":"hi"}')).toBe('hi')
  })

  test('text missing → empty string', () => {
    expect(parsePost('text', '{}')).toBe('')
  })

  test('post with one paragraph of text tags', () => {
    const content = JSON.stringify({
      zh_cn: {
        title: 'Title',
        content: [[{ tag: 'text', text: 'hello ' }, { tag: 'text', text: 'world' }]],
      },
    })
    expect(parsePost('post', content)).toBe('Title\n\nhello world')
  })

  test('post with link tag renders as [text](url)', () => {
    const content = JSON.stringify({
      zh_cn: {
        title: '',
        content: [[{ tag: 'a', text: 'Google', href: 'https://google.com' }]],
      },
    })
    expect(parsePost('post', content)).toContain('[Google](https://google.com)')
  })

  test('post with unknown tag preserves text when present', () => {
    const content = JSON.stringify({
      zh_cn: {
        title: '',
        content: [[{ tag: 'wtf', text: 'oops' }]],
      },
    })
    expect(parsePost('post', content)).toContain('oops')
  })

  test('image msg_type returns "[image:key]" with image_key', () => {
    expect(parsePost('image', '{"image_key":"img_x"}')).toBe('[image:img_x]')
  })

  test('image msg_type without key returns "(image)"', () => {
    expect(parsePost('image', '{}')).toBe('(image)')
  })

  test('file msg_type returns "(file: name)" placeholder', () => {
    expect(parsePost('file', '{"file_key":"file_x","file_name":"report.pdf"}')).toBe('(file: report.pdf)')
  })

  test('corrupt content does not throw', () => {
    expect(() => parsePost('text', 'not json')).not.toThrow()
    expect(parsePost('text', 'not json')).toBe('')
  })

  test('unknown msg_type returns "(<type>)"', () => {
    expect(parsePost('sticker', '{}')).toBe('(sticker)')
  })
})

describe('extractImageKeys', () => {
  test('extracts key from image message', () => {
    expect(extractImageKeys('image', '{"image_key":"img_abc"}')).toEqual(['img_abc'])
  })

  test('extracts keys from post with img nodes', () => {
    const post = JSON.stringify({
      zh_cn: {
        title: 'test',
        content: [[{ tag: 'img', image_key: 'img_1' }], [{ tag: 'text', text: 'hi' }, { tag: 'img', image_key: 'img_2' }]],
      },
    })
    expect(extractImageKeys('post', post)).toEqual(['img_1', 'img_2'])
  })

  test('returns empty for text message', () => {
    expect(extractImageKeys('text', '{"text":"hello"}')).toEqual([])
  })

  test('returns empty for invalid JSON', () => {
    expect(extractImageKeys('image', 'not json')).toEqual([])
  })
})

describe('safeName', () => {
  test('strips <, >, [, ], \\n, \\r, ;', () => {
    expect(safeName('hi<stuff>nope\n[inj];bye')).toBe('hi_stuff_nope__inj__bye')
  })

  test('undefined → undefined', () => {
    expect(safeName(undefined)).toBeUndefined()
  })

  test('clean name unchanged', () => {
    expect(safeName('report.pdf')).toBe('report.pdf')
  })
})

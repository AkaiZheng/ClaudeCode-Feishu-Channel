import { describe, expect, test } from 'bun:test'
import {
  chunk,
  parsePost,
  safeName,
  extractImageKeys,
  extractImageRefsFromRendered,
  detectImageExt,
  safeMessageId,
  buildNotificationContent,
} from '../src/feishu.ts'

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

  test('post with flat {title,content} (no i18n wrapper) renders text', () => {
    const content = JSON.stringify({
      title: '',
      content: [
        [{ tag: 'img', image_key: 'img_x', width: 100, height: 100 }],
        [{ tag: 'text', text: '能看到截图吗', style: [] }],
      ],
    })
    expect(parsePost('post', content)).toContain('能看到截图吗')
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

  test('image type with empty content returns []', () => {
    expect(extractImageKeys('image', '{}')).toEqual([])
  })

  test('post with no img nodes returns []', () => {
    const post = JSON.stringify({
      zh_cn: {
        title: 't',
        content: [[{ tag: 'text', text: 'hi' }, { tag: 'a', text: 'g', href: 'https://g.co' }]],
      },
    })
    expect(extractImageKeys('post', post)).toEqual([])
  })

  test('post with flat {title,content} (no i18n wrapper) extracts image_key', () => {
    const content = JSON.stringify({
      title: '',
      content: [
        [{ tag: 'img', image_key: 'img_flat', width: 100, height: 100 }],
        [{ tag: 'text', text: 'hi' }],
      ],
    })
    expect(extractImageKeys('post', content)).toEqual(['img_flat'])
  })

  test('post uses en_us when zh_cn missing', () => {
    const post = JSON.stringify({
      en_us: { title: '', content: [[{ tag: 'img', image_key: 'img_en' }]] },
    })
    expect(extractImageKeys('post', post)).toEqual(['img_en'])
  })

  test('post with only a non-standard locale falls back to first value', () => {
    const post = JSON.stringify({
      ja_jp: { title: '', content: [[{ tag: 'img', image_key: 'img_jp' }]] },
    })
    expect(extractImageKeys('post', post)).toEqual(['img_jp'])
  })
})

describe('detectImageExt', () => {
  test('PNG magic bytes', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(detectImageExt(buf)).toEqual({ ext: 'png', mimeType: 'image/png' })
  })

  test('JPEG magic bytes', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    expect(detectImageExt(buf)).toEqual({ ext: 'jpg', mimeType: 'image/jpeg' })
  })

  test('GIF87a magic bytes', () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
    expect(detectImageExt(buf)).toEqual({ ext: 'gif', mimeType: 'image/gif' })
  })

  test('GIF89a magic bytes', () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    expect(detectImageExt(buf)).toEqual({ ext: 'gif', mimeType: 'image/gif' })
  })

  test('WEBP magic bytes', () => {
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00, // size
      0x57, 0x45, 0x42, 0x50, // WEBP
    ])
    expect(detectImageExt(buf)).toEqual({ ext: 'webp', mimeType: 'image/webp' })
  })

  test('unknown bytes fall back to octet-stream', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03])
    expect(detectImageExt(buf)).toEqual({ ext: 'bin', mimeType: 'application/octet-stream' })
  })

  test('short buffer does not crash', () => {
    expect(detectImageExt(Buffer.from([0x89]))).toEqual({ ext: 'bin', mimeType: 'application/octet-stream' })
  })

  test('RIFF header without WEBP marker falls back to octet-stream', () => {
    // RIFF container but e.g. WAV (WAVE at offset 8), not an image
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45, // WAVE (not WEBP)
    ])
    expect(detectImageExt(buf)).toEqual({ ext: 'bin', mimeType: 'application/octet-stream' })
  })
})

describe('extractImageRefsFromRendered', () => {
  test('plain text → empty imageKeys, text unchanged', () => {
    expect(extractImageRefsFromRendered('hello world'))
      .toEqual({ text: 'hello world', imageKeys: [] })
  })

  test('single [Image: xxx] → extracts key, strips marker', () => {
    expect(extractImageRefsFromRendered('[Image: img_abc]\n能看到截图吗'))
      .toEqual({ text: '能看到截图吗', imageKeys: ['img_abc'] })
  })

  test('image-only content → empty text, key list', () => {
    expect(extractImageRefsFromRendered('[Image: img_x]'))
      .toEqual({ text: '', imageKeys: ['img_x'] })
  })

  test('multiple images + text → keeps text, order preserved', () => {
    const rendered = '[Image: img_1]\nhello\n[Image: img_2]\nworld'
    expect(extractImageRefsFromRendered(rendered))
      .toEqual({ text: 'hello\nworld', imageKeys: ['img_1', 'img_2'] })
  })

  test('image key with hyphens (real lark-cli form)', () => {
    const rendered = '[Image: img_v3_0210v_55ec5d63-2744-428a-be23-0620df5d0d3g]\nhi'
    expect(extractImageRefsFromRendered(rendered))
      .toEqual({ text: 'hi', imageKeys: ['img_v3_0210v_55ec5d63-2744-428a-be23-0620df5d0d3g'] })
  })

  test('merge_forward block is left intact (no markers inside)', () => {
    const rendered = '<forwarded_messages>\n[2026-04-21T16:32:28+08:00] Zekai Zheng:\n    hi\n</forwarded_messages>'
    const result = extractImageRefsFromRendered(rendered)
    expect(result.imageKeys).toEqual([])
    expect(result.text).toContain('<forwarded_messages>')
    expect(result.text).toContain('Zekai Zheng')
  })

  test('trims leading/trailing newlines left by marker stripping', () => {
    expect(extractImageRefsFromRendered('\n\n[Image: img_y]\n\n'))
      .toEqual({ text: '', imageKeys: ['img_y'] })
  })
})

describe('safeMessageId', () => {
  test('typical om_xxx id passes through unchanged', () => {
    expect(safeMessageId('om_x100b51576fc1dca8c358a6ae71a4fa8')).toBe('om_x100b51576fc1dca8c358a6ae71a4fa8')
  })

  test('path separators and dots get replaced', () => {
    expect(safeMessageId('../etc/passwd')).toBe('___etc_passwd')
  })

  test('shell metachars get replaced', () => {
    expect(safeMessageId('a;rm -rf /')).toBe('a_rm_-rf__')
  })

  test('preserves hyphens and underscores', () => {
    expect(safeMessageId('om-1_b-2')).toBe('om-1_b-2')
  })
})

describe('buildNotificationContent', () => {
  test('no images → text unchanged', () => {
    expect(buildNotificationContent('hello', [])).toBe('hello')
  })

  test('no images and empty text → empty string (no "(image)" fallback)', () => {
    expect(buildNotificationContent('', [])).toBe('')
  })

  test('text + single image → appends "[image 1: path]" on new line', () => {
    expect(buildNotificationContent('hello', ['/a/b.png']))
      .toBe('hello\n[image 1: /a/b.png]')
  })

  test('empty text + image → "(image)" fallback prefix', () => {
    expect(buildNotificationContent('', ['/a/b.png']))
      .toBe('(image)\n[image 1: /a/b.png]')
  })

  test('text + multiple images → numbered refs, order preserved', () => {
    expect(buildNotificationContent('hi', ['/one.png', '/two.jpg', '/three.gif']))
      .toBe('hi\n[image 1: /one.png]\n[image 2: /two.jpg]\n[image 3: /three.gif]')
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

import { describe, expect, it } from '@jest/globals'
import { ApiClient } from '../client'

const server = { id: 's1', name: 'Home', url: 'http://192.168.1.20:28470', token: 'tok' }

describe('ApiClient', () => {
  const client = new ApiClient(server, 'm-abc', () => {})

  it('sends the token, the client and the device on every request', () => {
    expect(client.headers()).toEqual({
      Authorization: 'Bearer tok',
      'X-Playpex-Client': expect.stringMatching(/^playpex-mobile\/.+; api=\d+$/),
      'X-Playpex-Device': 'm-abc',
    })
    expect(client.headerLines()).toContain('Authorization: Bearer tok')
  })

  it('builds API and media URLs under the prefix once', () => {
    expect(client.url('/catalog')).toBe('http://192.168.1.20:28470/api/v1/catalog')
    expect(client.url('/api/v1/catalog')).toBe('http://192.168.1.20:28470/api/v1/catalog')
    expect(client.mediaUrl('h_ab', '/index.m3u8')).toBe('http://192.168.1.20:28470/api/v1/media/h_ab/index.m3u8')
  })

  it('gives credentials only to the server’s own URLs', () => {
    expect(client.source('/plugins/m3u/assets/live.svg').headers?.Authorization).toBe('Bearer tok')
    expect(client.source('https://image.tmdb.org/t/p/w342/x.jpg')).toEqual({ uri: 'https://image.tmdb.org/t/p/w342/x.jpg' })
  })
})

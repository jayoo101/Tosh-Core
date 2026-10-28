import { describe, expect, it } from 'vitest'

import { rateLimitSubject } from './apiGuard'

describe('rateLimitSubject', () => {
  it('keeps an IPv4 address as itself', () => {
    expect(rateLimitSubject('203.0.113.7')).toBe('203.0.113.7')
  })

  it('counts every interface id in one /64 as the same caller', () => {
    const a = rateLimitSubject('2001:db8:1:2:aaaa:bbbb:cccc:dddd')
    expect(a).toBe('2001:db8:1:2::/64')
    expect(rateLimitSubject('2001:0db8:0001:0002:0000:0000:0000:0001')).toBe(a)
    expect(rateLimitSubject('2001:db8:1:2::1')).toBe(a)
    expect(rateLimitSubject('[2001:DB8:1:2::ffff]')).toBe(a)
    expect(rateLimitSubject('2001:db8:1:2::1%eth0')).toBe(a)
  })

  it('keeps different /64s apart', () => {
    expect(rateLimitSubject('2001:db8:1:3::1')).not.toBe(rateLimitSubject('2001:db8:1:2::1'))
  })

  it('expands a leading or trailing `::`', () => {
    expect(rateLimitSubject('::1')).toBe('0:0:0:0::/64')
    expect(rateLimitSubject('2001:db8::')).toBe('2001:db8:0:0::/64')
  })

  it('counts an IPv4-mapped address as the IPv4 it carries', () => {
    expect(rateLimitSubject('::ffff:203.0.113.7')).toBe('203.0.113.7')
  })

  it('leaves anything unparseable unchanged', () => {
    expect(rateLimitSubject('unknown')).toBe('unknown')
    expect(rateLimitSubject('1::2::3')).toBe('1::2::3')
    expect(rateLimitSubject('zz:1::')).toBe('zz:1::')
  })
})

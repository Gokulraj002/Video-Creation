import { describe, expect, it } from 'vitest';
import { parseContactsCsv } from '../src/contacts';
import { normalizePhone } from '../src/phone';
import { fillProps, fillString } from '../src/placeholders';

describe('normalizePhone', () => {
  it('adds the default country code to 10-digit numbers', () => {
    expect(normalizePhone('98765 43210', '91')).toBe('919876543210');
    expect(normalizePhone('09876543210', '91')).toBe('919876543210');
  });

  it('keeps explicit international numbers', () => {
    expect(normalizePhone('+1 (415) 555-0100', '91')).toBe('14155550100');
    expect(normalizePhone('0044 20 7946 0958', '91')).toBe('442079460958');
    expect(normalizePhone('919876543210', '91')).toBe('919876543210');
  });

  it('rejects junk', () => {
    expect(normalizePhone('', '91')).toBeNull();
    expect(normalizePhone('12345', '91')).toBeNull();
    expect(normalizePhone('abc', '91')).toBeNull();
  });
});

describe('placeholders', () => {
  it('fills vars and fallbacks', () => {
    expect(fillString('Hi {name|there}!', { name: 'Asha' })).toBe('Hi Asha!');
    expect(fillString('Hi {name|there}!', { name: '  ' })).toBe('Hi there!');
    expect(fillString('In {city}', {})).toBe('In ');
  });

  it('only touches string props', () => {
    expect(fillProps({ a: 'Hi {name}', b: 3 }, { name: 'Ravi' })).toEqual({ a: 'Hi Ravi', b: 3 });
  });
});

describe('parseContactsCsv', () => {
  it('parses contacts, extra columns become vars', () => {
    const csv = '﻿Name,Mobile,City\nAsha,9876543210,Chennai\nRavi,+91 98765 00000,Madurai\n';
    const { contacts, invalid } = parseContactsCsv(csv, '91');
    expect(invalid).toEqual([]);
    expect(contacts).toEqual([
      { name: 'Asha', phone: '919876543210', vars: { name: 'Asha', city: 'Chennai', phone: '919876543210' } },
      { name: 'Ravi', phone: '919876500000', vars: { name: 'Ravi', city: 'Madurai', phone: '919876500000' } },
    ]);
  });

  it('reports invalid and duplicate rows', () => {
    const csv = 'name,phone\nA,123\nB,9876543210\nC,98765 43210\n';
    const { contacts, invalid } = parseContactsCsv(csv, '91');
    expect(contacts).toHaveLength(1);
    expect(invalid).toEqual([
      { row: 2, reason: 'invalid phone "123"' },
      { row: 4, reason: 'duplicate phone 919876543210' },
    ]);
  });

  it('flags a missing phone column', () => {
    const { contacts, invalid } = parseContactsCsv('name,city\nA,X\n', '91');
    expect(contacts).toEqual([]);
    expect(invalid).toEqual([{ row: 2, reason: 'missing phone column' }]);
  });
});

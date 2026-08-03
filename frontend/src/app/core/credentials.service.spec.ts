import { readCookie } from './credentials.service';

describe('readCookie', () => {
  it('reads and decodes an exact cookie name', () => {
    expect(readCookie('password=1234; id=AB%20CD; userid=wrong', 'id')).toBe('AB CD');
  });

  it('returns an empty string for missing or malformed values', () => {
    expect(readCookie('id=%E0%A4%A', 'id')).toBe('');
    expect(readCookie('password=1234', 'id')).toBe('');
  });
});

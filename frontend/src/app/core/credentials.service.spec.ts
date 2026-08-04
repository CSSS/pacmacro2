import { readCookie } from './credentials.service';

describe('readCookie', () => {
  it('reads and decodes an exact cookie name', () => {
    expect(readCookie('theme=dark; id=AB%20CD; userid=wrong', 'id')).toBe('AB CD');
  });

  it('returns an empty string for missing or malformed values', () => {
    expect(readCookie('id=%E0%A4%A', 'id')).toBe('');
    expect(readCookie('theme=dark', 'id')).toBe('');
  });
});

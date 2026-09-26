import { describe, expect, it } from 'vitest';
import { sanitizeChannelDisplayName } from './channelName.js';

describe('sanitizeChannelDisplayName', () => {
  it('drops quality words and the parentheses they leave behind', () => {
    expect(sanitizeChannelDisplayName('ASPIRE (HD)')).toBe('ASPIRE');
    expect(sanitizeChannelDisplayName('ASPIRE ()')).toBe('ASPIRE');
    expect(sanitizeChannelDisplayName('A&E HD')).toBe('A&E');
    expect(sanitizeChannelDisplayName('HBO West HD')).toBe('HBO West');
    expect(sanitizeChannelDisplayName('MLB Extra Innings HD 731')).toBe(
      'MLB Extra Innings 731'
    );
  });

  it('keeps identifiers that are not quality labels', () => {
    expect(sanitizeChannelDisplayName('FOX (103A)')).toBe('FOX (103A)');
    expect(sanitizeChannelDisplayName('ESPN2')).toBe('ESPN2');
  });
});

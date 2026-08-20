/**
 * The greeting name.
 *
 * `"Dr. Meera Iyer".split(' ')[0]` is `"Dr."`, and that is what the faculty
 * console greeted people with: "Good evening, Dr..". It is a small thing that
 * is visible every single morning, to exactly the users most likely to have a
 * title in their name.
 */

import { describe, it, expect } from 'vitest';
import { firstNameOf } from './FacultyLandingPage';

describe('firstNameOf', () => {
  it('skips a title and greets by name', () => {
    expect(firstNameOf('Dr. Meera Iyer')).toBe('Meera');
    expect(firstNameOf('Prof Sunil Rao')).toBe('Sunil');
    expect(firstNameOf('Ms. Anita Desai')).toBe('Anita');
  });

  it('leaves an ordinary name alone', () => {
    expect(firstNameOf('Priya Menon')).toBe('Priya');
    expect(firstNameOf('Prince')).toBe('Prince');
  });

  it('survives extra whitespace', () => {
    expect(firstNameOf('  Dr.   Meera   Iyer ')).toBe('Meera');
  });

  it('falls back rather than greeting nobody when a name is only a title', () => {
    // Unlikely, but the alternative is "Good evening, ." on someone's screen.
    expect(firstNameOf('Dr.')).toBe('Dr.');
    expect(firstNameOf('')).toBe('');
  });

  it('is case-insensitive about titles', () => {
    expect(firstNameOf('DR. Meera Iyer')).toBe('Meera');
    expect(firstNameOf('prof. sunil')).toBe('sunil');
  });
});

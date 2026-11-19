import { describe, expect, it } from 'vitest';
import { detectBrand } from '../src/brands.js';

describe('detectBrand (name-based, spec priority Statiq > Tata > BPCL > HP)', () => {
  const cases: Array<[string, string]> = [
    // observed real station names
    ['Statiq Hotel The Suryaa Station', 'statiq'],
    ['EESL Statiq DTC Nehru Place Charging Station', 'statiq'],
    ['Statiq x TATA.ev Nexus Select City Station', 'statiq'], // co-branded: Statiq wins
    ['Statiq BSES Hub Rajouri Garden', 'statiq'],
    ['GMR Green Worldmark 1 Charging Station', 'other'],
    ['GLIDA DLF Promenade', 'other'],
    ['GLIDA HPCL Batra Bros', 'hp'],
    ['BP-GOLDEN PARK', 'bpcl'],
    ['BP - VASANT VIHAR', 'bpcl'],
    ['Tata Power Charging Station Delhi', 'tata'],
    ['TATA.ev Nexus Select Citywalk', 'tata'],
    ['Earthtron EV Shastri Park', 'other'],
    // guard against false substring positives
    ['Bypass Road Charging', 'other'],
    ['Shankar Filling Station', 'other'],
    ['Hpake Suryaa Station', 'other'],
  ];

  it.each(cases)('%s -> %s', (name, expected) => {
    expect(detectBrand(name)).toBe(expected);
  });

  it('handles null/empty names', () => {
    expect(detectBrand(null)).toBe('other');
    expect(detectBrand('')).toBe('other');
  });
});

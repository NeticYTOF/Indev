import { describe, expect, it } from 'vitest';
import { PhotonGeocoder } from '../src/geocode.js';

const photonResponse = {
  features: [
    {
      geometry: { coordinates: [75.7873, 26.9124] },
      properties: { name: 'Jaipur', city: 'Jaipur', state: 'Rajasthan', country: 'India' },
    },
    {
      geometry: { coordinates: [77.209, 28.6139] },
      properties: { name: 'New Delhi', city: 'New Delhi', state: 'Delhi', country: 'India' },
    },
    {
      // street-level hit without a name: falls back to street
      geometry: { coordinates: [77.1, 28.5] },
      properties: { street: 'Mehrauli Road', city: 'Delhi', state: 'Delhi', country: 'India' },
    },
  ],
};

describe('PhotonGeocoder', () => {
  it.each([
    {}, { features: null }, null,
    { features: {} }, { features: [null] },
    { features: [{ geometry: { coordinates: [77, 91] }, properties: { name: 'Invalid' } }] },
    { features: [{ geometry: { coordinates: ['77', 28] }, properties: { name: 'Invalid' } }] },
    { features: [{ geometry: { coordinates: [77] }, properties: { name: 'Invalid' } }] },
    { features: [{ geometry: { coordinates: [77, 28] }, properties: { name: 42 } }] },
  ])('rejects malformed place responses without retrying: %j', async (payload) => {
    let calls = 0;
    const impl = (async () => { calls++; return new Response(JSON.stringify(payload), { status: 200 }); }) as typeof fetch;
    const geocoder = new PhotonGeocoder({ fetchImpl: impl, retries: 0 });
    await expect(geocoder.search('Town')).rejects.toThrow('Invalid geocoding response');
    expect(calls).toBe(1);
  });

  it('searches with India bias and parses hits', async () => {
    const calls: string[] = [];
    const impl = (async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify(photonResponse), { status: 200 });
    }) as typeof fetch;
    const geocoder = new PhotonGeocoder({ baseUrl: 'https://geo.test', fetchImpl: impl });
    const hits = await geocoder.search('Jaipur');
    expect(hits).toHaveLength(3);
    expect(hits[0]).toMatchObject({ name: 'Jaipur', lat: 26.9124, lon: 75.7873, state: 'Rajasthan' });
    expect(hits[0]?.label).toBe('Jaipur, Rajasthan, India');
    expect(hits[1]?.label).toBe('New Delhi, Delhi, India');
    // city=Delhi then state=Delhi de-duplicated
    expect(hits[2]?.label).toBe('Mehrauli Road, Delhi, India');
    expect(calls[0]).toContain('q=Jaipur');
    expect(calls[0]).toContain('lat=22.5'); // India bias
  });

  it.each([
    [{ name: '', street: 'Main Street' }, 'Main Street'],
    [{ name: '   ', street: 'Main Street' }, 'Main Street'],
    [{ name: '', street: '', city: '', state: '', country: '' }, 'Unnamed place'],
    [{ name: '   ', street: '   ', city: '   ', state: '   ', country: '   ' }, 'Unnamed place'],
    [{}, 'Unnamed place'],
  ])('uses the first nonblank name for %j', async (properties, expected) => {
    const impl = (async () => new Response(JSON.stringify({ features: [
      { geometry: { coordinates: [75.5, 26.5] }, properties },
    ] }), { status: 200 })) as typeof fetch;
    const geocoder = new PhotonGeocoder({ fetchImpl: impl, retries: 0 });
    const hit = (await geocoder.search('Town'))[0];
    expect(hit?.name).toBe(expected);
    expect(hit?.label).toBe(expected);
    expect(hit?.lat).toBe(26.5);
    expect(hit?.lon).toBe(75.5);
  });

  it('returns empty array when there are no features', async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ features: [] }), { status: 200 })) as typeof fetch;
    const geocoder = new PhotonGeocoder({ baseUrl: 'https://geo.test', fetchImpl: impl });
    const hits = await geocoder.search('zzzz-no-place');
    expect(hits).toEqual([]);
  });
});

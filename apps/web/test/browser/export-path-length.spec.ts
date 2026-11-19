import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { TripPlan } from '@indeev/core';
import { buildAnimatedExportSvg } from '../../src/export.js';

test('a winding export finishes drawing the entire route, not a fixed pixel prefix', async ({ page }) => {
  const plan = {
    geometry: Array.from({ length: 12 }, (_, i) => ({ lat: 28 - i / 11, lon: 77 + i % 2 })),
    stops: [], origin: { label: 'A' }, destination: { label: 'B' },
    vehicle: { label: 'Synthetic geometry fixture' }, source: 'synthetic',
    totals: { totalTimeMin: 500, chargeTimeMin: 0, finalSocPct: 25, estPriceInr: null },
    routeDistanceKm: 500, createdAt: '2026-11-19T18:00:00Z', status: 'ok',
  } as unknown as TripPlan;
  const file = test.info().outputPath('winding.svg');
  await writeFile(file, buildAnimatedExportSvg(plan));
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.goto(pathToFileURL(file).href);
  const path = page.locator('path.draw');
  expect(await path.evaluate(el => (el as SVGPathElement).getTotalLength())).toBeGreaterThan(4000);
  await expect(path).toHaveAttribute('pathLength', '1');
  expect(await path.evaluate(el => getComputedStyle(el).strokeDasharray)).toBe('1px');
  // Observe real CSS completion rather than forcing the finished style.
  // The finished promises wait only for this document's finite animations.
  const animationStates = await page.evaluate(async () => {
    const animations = document.getAnimations();
    await Promise.all(animations.map(animation => animation.finished));
    return animations.map(animation => animation.playState);
  });
  expect(animationStates.length).toBeGreaterThan(0);
  expect(animationStates.every(state => state === 'finished')).toBe(true);
  expect(await path.evaluate(el => getComputedStyle(el).strokeDashoffset)).toBe('0px');
  await page.screenshot({ path: test.info().outputPath('winding.png') });
});

import { expect, test } from '@playwright/test';

interface PrintFixtureOptions {
  stops: number;
  sparse?: boolean;
  label: string;
}

function stationView(index: number, sparse: boolean) {
  return {
    stationId: 9000 + index,
    name: sparse && index === 0
      ? 'Sparse evidence stop with an intentionally long name'
      : `Corridor charging stop ${index + 1}`,
    brand: 'statiq',
    lat: 27 + index * 0.01,
    lon: 76 + index * 0.01,
    address: null,
    city: null,
    hours: null,
    openText: null,
    rating: null,
    reviewCount: null,
    reliability: null,
    fetchedAt: '2026-11-20T10:00:00.000Z',
    amenities: [],
    stationUrl: null,
    navUrl: null,
    chargers: [],
  };
}

function printPlan({ stops: count, sparse = false, label }: PrintFixtureOptions) {
  const chainageStep = 120;
  const stops = Array.from({ length: count }, (_, index) => ({
    station: stationView(index, sparse),
    chainageKm: (index + 1) * chainageStep,
    legKm: chainageStep + (index % 2 === 0 ? 2 : 3),
    detourKm: index % 2 === 0 ? 1 : 1.5,
    // Sparse facts are deliberately invalid; the briefing must show Unknown,
    // not drop the row or repair arithmetic.
    arriveSocPct: sparse && index === 0 ? 140 : 24,
    leaveSocPct: 78,
    chargeKwh: sparse && index === 0 ? -3 : 42.7,
    pricePerKwh: 22.75,
    estPriceInr: sparse && index === 0 ? -1 : 854,
    chargeTimeMin: sparse && index === 0 ? -4 : 42,
    arrivalEtaMin: 130 + index * 150,
    departureEtaMin: 172 + index * 150,
  }));
  return {
    id: `print-${label}`,
    createdAt: '2026-11-20T12:00:00.000Z',
    origin: { label: 'Delhi origin', lat: 28.6139, lon: 77.209 },
    destination: { label: 'Jaipur destination', lat: 26.9124, lon: 75.7873 },
    vehicle: {
      label: 'Tata Harrier EV 75 kWh', catalogId: 'tata-harrier-ev-75',
      batteryKwh: 75, claimedRangeKm: 627, realWorldRangeKm: 300,
    },
    status: sparse ? 'degraded' : 'ok',
    source: 'synthetic',
    routeDistanceKm: (count + 1) * chainageStep,
    routeDurationMin: (count + 1) * 120,
    geometry: [
      { lat: 28.6139, lon: 77.209 },
      { lat: 26.9124, lon: 75.7873 },
    ],
    stops,
    stationsSeen: count,
    warnings: sparse ? ['Sparse fixture keeps every stop row with explicit Unknown cells.'] : [],
    totals: {
      distanceKm: (count + 1) * chainageStep,
      driveTimeMin: (count + 1) * 120,
      chargeTimeMin: count * 42,
      totalTimeMin: (count + 1) * 120 + count * 42,
      chargeKwh: count * 42.7,
      estPriceInr: sparse ? null : count * 854,
      finalSocPct: 12,
    },
  };
}

async function renderPrintFixture(page: import('@playwright/test').Page, options: PrintFixtureOptions): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('**/api/plan', (route) => route.fulfill({ json: { plan: printPlan(options) } }));
  await page.goto('/');
  for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
    await page.getByRole('searchbox', { name, exact: true }).fill(query!);
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  await expect(page.locator('[data-journey-briefing]')).toBeVisible();
  await expect(page.locator('.briefing-itinerary tbody tr')).toHaveCount(options.stops);
  await page.emulateMedia({ media: 'print' });
}

for (const options of [
  { label: 'normal', stops: 2 },
  { label: 'sparse', stops: 2, sparse: true },
  { label: 'long', stops: 14 },
] as PrintFixtureOptions[]) {
  test(`journey print keeps ${options.label} itinerary headers with the first row`, async ({ page }, info) => {
    await renderPrintFixture(page, options);
    const briefing = page.locator('[data-journey-briefing]');

    const fragmentation = await briefing.evaluate((section) => {
      const heading = section.querySelector('.briefing-itinerary-heading') as HTMLElement;
      const caption = section.querySelector('.briefing-itinerary-caption') as HTMLElement;
      const table = section.querySelector('.briefing-itinerary') as HTMLTableElement;
      const head = table.tHead as HTMLTableSectionElement;
      const firstRow = table.tBodies[0]?.rows[0] as HTMLTableRowElement;
      const laterRow = table.tBodies[0]?.rows[1] as HTMLTableRowElement | undefined;
      const style = (element: Element) => getComputedStyle(element);
      return {
        headingBreakAfter: style(heading).breakAfter,
        captionBreakAfter: style(caption).breakAfter,
        headBreakAfter: style(head).breakAfter,
        firstRowBreakBefore: style(firstRow).breakBefore,
        tableBreakInside: style(table).breakInside,
        rowBreakInside: style(firstRow).breakInside,
        laterRowBreakInside: laterRow ? style(laterRow).breakInside : 'n/a',
      };
    });
    expect(fragmentation).toMatchObject({
      headingBreakAfter: 'avoid',
      captionBreakAfter: 'avoid',
      headBreakAfter: 'avoid',
      firstRowBreakBefore: 'avoid',
      tableBreakInside: 'auto',
      rowBreakInside: 'avoid',
    });
    if (fragmentation.laterRowBreakInside !== 'n/a') expect(fragmentation.laterRowBreakInside).toBe('avoid');

    const widths = await briefing.evaluate((section) => {
      const table = section.querySelector('.briefing-itinerary') as HTMLTableElement;
      const cells = Array.from(table.querySelectorAll('.briefing-itinerary thead th'));
      const headCell = (index: number) => table.tHead?.rows[0]?.cells[index] as HTMLElement;
      const px = (element: HTMLElement) => element.getBoundingClientRect().width;
      return {
        tableLayout: getComputedStyle(table).tableLayout,
        tableMinWidth: Number.parseFloat(getComputedStyle(table).minWidth),
        chargeTimeWidth: px(headCell(4)),
        costWidth: px(headCell(5)),
        headerWhiteSpace: cells.map((cell) => getComputedStyle(cell).whiteSpace),
        pageFits: document.body.scrollWidth <= window.innerWidth,
      };
    });
    expect(widths.tableLayout).toBe('fixed');
    expect(widths.tableMinWidth).toBe(0);
    expect(widths.chargeTimeWidth).toBeGreaterThan(50);
    expect(widths.costWidth).toBeGreaterThan(40);
    expect(widths.headerWhiteSpace.every((value) => value === 'nowrap')).toBe(true);
    expect(widths.pageFits).toBe(true);

    if (options.sparse) {
      await expect(briefing.locator('.briefing-itinerary tbody tr').first()).toContainText('Unknown');
    }

    await briefing.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`journey-print-${options.label}-table.png`),
      fullPage: true,
    });
    const pdf = await page.pdf({
      path: info.outputPath(`journey-print-${options.label}.pdf`),
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    });
    expect(pdf.byteLength).toBeGreaterThan(1_000);
  });
}

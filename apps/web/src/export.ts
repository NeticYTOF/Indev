/** Nearest point on a screen-space polyline (for marker placement). */
function projectOntoPolyline(
  poly: Array<{ x: number; y: number }>,
  p: { x: number; y: number },
): { x: number; y: number } {
  let best = { x: poly[0]?.x ?? 0, y: poly[0]?.y ?? 0 };
  let bestD = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1] as { x: number; y: number };
    const b = poly[i] as { x: number; y: number };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = { x: cx, y: cy };
    }
  }
  return best;
}

/**
 * Animated trip export: a self-contained SVG card where the route draws
 * itself, stops pop in sequence, and the stats fade up. Flat colors only.
 * The file plays in any browser; it can be shared as-is.
 */
import type { TripPlan } from '@indeev/core';

export function buildAnimatedExportSvg(plan: TripPlan): string {
  // project geometry to a 1200x630 viewBox with generous margins
  const W = 1200;
  const H = 630;
  const padX = 70;
  const padTop = 90;
  const padBottom = 110;
  const pts = plan.geometry.map((p) => ({ lat: p.lat, lon: p.lon }));
  if (pts.length < 2) throw new Error('Route geometry is empty');

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of pts) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }
  const spanLat = Math.max(maxLat - minLat, 0.01);
  const spanLon = Math.max(maxLon - minLon, 0.01);
  const availW = W - padX * 2;
  const availH = H - padTop - padBottom;
  const scale = Math.min(availW / spanLon, availH / spanLat);
  const px = (p: { lat: number; lon: number }): { x: number; y: number } => ({
    x: padX + (p.lon - minLon) * scale + (availW - spanLon * scale) / 2,
    y: H - padBottom - (p.lat - minLat) * scale - (availH - spanLat * scale) / 2,
  });

  const path = pts
    .map((p, i) => {
      const { x, y } = px(p);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const originP = px(pts[0] as { lat: number; lon: number });
  const destP = px(pts[pts.length - 1] as { lat: number; lon: number });

  // Markers sit ON the drawn route: project each stop onto the rendered
  // polyline (schematic convention - a marker marks the stop's position
  // along the route, and synthetic fixtures whose coordinates sit off the
  // schematic line stay visually on the line).
  const routeScreenPts = pts.map((p) => px(p));
  const stopPts = plan.stops.map((s) => {
    const raw = px({ lat: s.station.lat, lon: s.station.lon });
    return projectOntoPolyline(routeScreenPts, raw);
  });

  const totalPathLen = 2600; // generous; actual length is shorter and that's fine
  const drawTime = 2.2; // seconds for the route draw

  const stopCircles = stopPts
    .map((p, i) => {
      const begin = (drawTime * (i + 1)) / (stopPts.length + 1);
      return `
    <g class="stop" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">
      <circle r="13" fill="#ffffff"/>
      <circle r="10" fill="#101623">
        <animate attributeName="r" from="10" to="10" begin="${begin.toFixed(2)}s" dur="0.01s" fill="freeze"/>
        <animate attributeName="opacity" from="0" to="1" begin="${begin.toFixed(2)}s" dur="0.28s" fill="freeze"/>
      </circle>
      <text y="4" text-anchor="middle" font-size="11" font-weight="700" fill="#ffffff" font-family="Inter, sans-serif">${i + 1}</text>
    </g>`;
    })
    .join('');

  const stats = [
    { label: 'Distance', value: `${Math.round(plan.routeDistanceKm)} km` },
    { label: 'Total time', value: formatMin(plan.totals.totalTimeMin) },
    { label: 'Charging stops', value: String(plan.stops.length) },
    { label: 'Charging time', value: formatMin(plan.totals.chargeTimeMin) },
    { label: 'Est. cost', value: plan.totals.estPriceInr != null ? `Rs. ${Math.round(plan.totals.estPriceInr).toLocaleString('en-IN')}` : '—' },
    { label: 'Arrival charge', value: `${Math.round(plan.totals.finalSocPct)}%` },
  ];

  const statBlocks = stats
    .map(
      (s, i) => `
    <g class="stat" transform="translate(${70 + i * 177}, ${H - 66})">
      <text font-size="11" font-weight="700" fill="#a8b0c0" font-family="Inter, sans-serif" letter-spacing="1.2">${escapeXml(s.label).toUpperCase()}</text>
      <text y="24" font-size="20" font-weight="700" fill="#101623" font-family="Inter, sans-serif">${escapeXml(s.value)}</text>
    </g>`,
    )
    .join('');

  const routeTitle = escapeXml(`${plan.origin.label} → ${plan.destination.label}`);
  const vehicleLine = escapeXml(
    plan.vehicle.label + (plan.vehicle.realWorldRangeKm ? ` · real-world ${plan.vehicle.realWorldRangeKm} km` : ''),
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Inter, sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#e3e7ee" stroke-width="2"/>

  <style>
    .draw { stroke-dasharray: ${totalPathLen}; stroke-dashoffset: ${totalPathLen}; animation: draw ${drawTime}s cubic-bezier(.4,.1,.2,1) forwards; }
    @keyframes draw { to { stroke-dashoffset: 0; } }
    .fade { opacity: 0; animation: fadeup .5s ease-out forwards; animation-delay: ${drawTime}s; }
    @keyframes fadeup { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    text { user-select: none; }
  </style>

  <text x="${padX}" y="52" font-size="30" font-weight="700" fill="#101623">${routeTitle}</text>
  <text x="${padX}" y="76" font-size="15" fill="#7d8698">${vehicleLine}${plan.source === 'synthetic' ? ' · SYNTHETIC DATA (MOCK) — SCHEMATIC GEOMETRY' : ''}</text>

  <!-- static base route: full path at low opacity so previews without
       SMIL/CSS animation still show the route -->
  <path d="${path}" fill="none" stroke="#2463eb" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="0.18"/>
  <path d="${path}" fill="none" stroke="#ffffff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" opacity="0.001"/>
  <path class="draw" d="${path}" fill="none" stroke="#2463eb" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>

  <g transform="translate(${originP.x.toFixed(1)},${originP.y.toFixed(1)})">
    <circle r="11" fill="#2463eb" stroke="#ffffff" stroke-width="3"/>
  </g>
  <g transform="translate(${destP.x.toFixed(1)},${destP.y.toFixed(1)})">
    <circle r="11" fill="#dc2626" stroke="#ffffff" stroke-width="3"/>
  </g>
  ${stopCircles}

  <line x1="${padX}" y1="${H - 100}" x2="${W - padX}" y2="${H - 100}" stroke="#e3e7ee" stroke-width="1"/>
  <g class="fade">${statBlocks}</g>
  <text class="fade" x="${padX}" y="${H - 16}" font-size="11" fill="#a8b0c0">IndEV — planned ${escapeXml(new Date(plan.createdAt).toLocaleDateString('en-IN'))}${plan.status === 'degraded' ? ' · partial coverage' : ''}${plan.source === 'synthetic' ? ' · synthetic schematic, not live geometry' : ''}</text>
</svg>`;
}

export function downloadAnimatedExport(plan: TripPlan): void {
  const svg = buildAnimatedExportSvg(plan);
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const name = `${plan.origin.label}-${plan.destination.label}`.replace(/[^\w-]+/g, '-').replace(/-+/g, '-');
  a.download = `indeev-${name.slice(0, 60).toLowerCase()}.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatMin(min: number): string {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? `${h} h ${r > 0 ? `${r} min` : ''}`.trim() : `${m} min`;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

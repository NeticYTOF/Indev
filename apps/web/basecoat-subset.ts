import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginOption } from 'vite';

/**
 * Basecoat ships its component look as one style file (styles/vega.css):
 * `/* Name *\/` sections inside a single `@layer components`. The app
 * renders only a few of those components, so this keeps just those
 * sections. Tailwind reads `@import`s straight from disk (not through
 * Vite transforms), so the subset is written to a generated file that
 * src/ui/theme.css imports. It is regenerated whenever Vite starts.
 */
const KEEP = new Set([
  'Button', 'Textarea', 'Input', 'Native Select', 'Badge', 'Kbd', 'Label',
  'Progress', 'Skeleton', 'Tooltip',
]);

/** Known section names: any other comment is a note inside the current section. */
const SECTIONS = new Set([
  'Accordion', 'Button', 'Button Group', 'Tabs', 'Textarea', 'Input', 'Native Select',
  'Alert', 'Avatar', 'Badge', 'Breadcrumb', 'Command', 'Combobox', 'Select', 'Dialog',
  'Drawer', 'Sheet', 'Dropdown Menu', 'Popover', 'Carousel', 'Card', 'Chart', 'Checkbox',
  'Radio', 'Switch', 'Field', 'Input Group', 'Empty', 'Message', 'Trace', 'Marker', 'Item',
  'Kbd', 'Label', 'Sidebar', 'Progress', 'Skeleton', 'Table', 'Tooltip', 'Toast', 'Slider',
  'Bubble', 'Attachment', 'Code Block', 'Input OTP',
]);

export function subsetBasecoatStyle(css: string): string {
  const header = /^[ \t]*\/\* ([A-Za-z][A-Za-z ]*?) \*\/[ \t]*$/;
  const lines = css.split(/\r?\n/);
  const out: string[] = ['@layer components {'];
  let keep = false;
  let opened = false;
  const missing = new Set(KEEP);
  for (const line of lines) {
    if (!opened && line.trim() === '@layer components {') { opened = true; continue; }
    const match = header.exec(line);
    const name = match?.[1];
    if (name && SECTIONS.has(name)) {
      keep = KEEP.has(name);
      missing.delete(name);
      if (keep) out.push(line);
      continue;
    }
    if (keep) out.push(line);
  }
  if (!opened) throw new Error('basecoat-subset: vega.css no longer opens one @layer components block');
  if (missing.size) throw new Error(`basecoat-subset: sections not found: ${[...missing].join(', ')}`);
  // Drop the layer's own closing brace if a kept section held it, then close once.
  const text = out.join('\n');
  const balance = (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length;
  if (balance < 1) {
    const last = out.lastIndexOf('}');
    if (last >= 0) out.splice(last, 1);
  }
  out.push('}', '');
  return out.join('\n');
}

const here = dirname(fileURLToPath(import.meta.url));
export const SUBSET_PATH = join(here, 'src', 'ui', 'generated', 'basecoat-vega.css');

export function writeBasecoatSubset(): void {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('basecoat-css/package.json');
  const source = readFileSync(join(dirname(pkg), 'dist', 'styles', 'vega.css'), 'utf8');
  const next = subsetBasecoatStyle(source);
  mkdirSync(dirname(SUBSET_PATH), { recursive: true });
  if (!existsSync(SUBSET_PATH) || readFileSync(SUBSET_PATH, 'utf8') !== next) writeFileSync(SUBSET_PATH, next);
}

export function basecoatSubset(): PluginOption {
  return {
    name: 'indeev-basecoat-subset',
    enforce: 'pre',
    config() { writeBasecoatSubset(); },
  };
}

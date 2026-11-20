import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function sourceFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: URL[] = [];
  for (const entry of entries) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) files.push(...await sourceFiles(url));
    else if (entry.name.endsWith('.ts')) files.push(url);
  }
  return files;
}

describe('browser-safe package boundary', () => {
  it('never imports the full core barrel at runtime from web source', async () => {
    const files = await sourceFiles(new URL('../src/', import.meta.url));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const line of source.split(/\r?\n/)) {
        if (!line.includes("from '@indeev/core'")) continue;
        expect(line, `${file.pathname}: ${line}`).toMatch(/^\s*import type\b/);
      }
    }
  });

  it('exposes an isolated classifier subpath and keeps its imports type-only', async () => {
    const webSource = await readFile(new URL('../src/station-evidence.ts', import.meta.url), 'utf8');
    expect(webSource).toContain("from '@indeev/core/plug-classifier'");
    expect(webSource).not.toContain("import { classifyPlug, type PlanStop } from '@indeev/core'");

    const pkg = JSON.parse(await readFile(new URL('../../packages/core/package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports['./plug-classifier']).toBe('./src/plug-classifier.ts');

    const classifier = await readFile(
      new URL('../../packages/core/src/plug-classifier.ts', import.meta.url), 'utf8',
    );
    const runtimeImports = classifier.split(/\r?\n/).filter((line) =>
      /^\s*import\s/.test(line) && !/^\s*import type\s/.test(line));
    expect(runtimeImports).toEqual([]);
  });
});

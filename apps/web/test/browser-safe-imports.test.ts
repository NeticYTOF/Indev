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

/**
 * Focused source normalization: records static ES import declarations with
 * named/namespace/default clauses, including multi-line named clauses and
 * either quote style. It deliberately does not evaluate project code.
 */
function importStatements(source: string): Array<{ typeOnly: boolean; clause: string; module: string }> {
  const pattern = /\bimport\s+(type\s+)?((?:\{[^{}]*\}|\*[\s\S]*?\sas\s+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"])/g;
  return Array.from(source.matchAll(pattern), (match) => ({
    typeOnly: Boolean(match[1]),
    clause: (match[2] ?? '').replace(/\s+/g, ' ').trim(),
    module: match[3] ?? '',
  }));
}

describe('browser-safe package boundary', () => {
  it('never imports the full core barrel at runtime from web source', async () => {
    const files = await sourceFiles(new URL('../src/', import.meta.url));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const statement of importStatements(source)) {
        if (statement.module !== '@indeev/core') continue;
        expect(statement.typeOnly, `${file.pathname}: ${statement.clause}`).toBe(true);
      }
    }
  });

  it('exposes an isolated classifier subpath and keeps its imports type-only', async () => {
    const webSource = await readFile(new URL('../src/station-evidence.ts', import.meta.url), 'utf8');
    const webImports = importStatements(webSource);
    expect(webImports.some((statement) =>
      statement.module === '@indeev/core/plug-classifier' && statement.clause.includes('classifyPlugValues'))).toBe(true);
    expect(webImports.some((statement) =>
      statement.module === '@indeev/core' && !statement.typeOnly)).toBe(false);

    const pkg = JSON.parse(await readFile(
      new URL('../../../packages/core/package.json', import.meta.url), 'utf8',
    )) as { exports: Record<string, string> };
    expect(pkg.exports['./plug-classifier']).toBe('./src/plug-classifier.ts');

    const classifier = await readFile(
      new URL('../../../packages/core/src/plug-classifier.ts', import.meta.url), 'utf8',
    );
    const runtimeImports = importStatements(classifier).filter((statement) => !statement.typeOnly);
    expect(runtimeImports).toEqual([]);
  });
});

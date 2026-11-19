/**
 * Fail-closed UI verification launcher tests.
 *
 * 1. Integration: the real script boots the real server in mock mode on an
 *    isolated port, its gate passes, and its probes confirm mock:true plus
 *    synthetic plans. A live-mode server can never serve this path quietly.
 * 2. Unit (negative): a non-mock health endpoint must fail the probe.
 */
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { probeHealth, probeSyntheticPlan } from '../../../scripts/ui-verify.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A free ephemeral port (listen(0) then close). The 8787/5173 dev ports
 *  are NEVER used by test runs, and no fixed test port can collide with a
 *  PARALLEL suite (the proven 8891 sharing that caused the acceptance
 *  provenance race). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, 'localhost', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface FakeServerHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

function startFakeServer(
  handler: (req: { url?: string; method?: string }, res: { setHeader(k: string, v: string): void; end(body: string): void; statusCode: number }) => void,
): Promise<FakeServerHandle> {
  const server = createServer((req, res) => handler(req as never, res as never));
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveServer({
        server,
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('probeHealth (mock gate)', () => {
  it('returns health JSON for a mock server', async () => {
    const fake = await startFakeServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, mock: true, chargersSeen: 0 }));
    });
    try {
      const health = await probeHealth(`http://127.0.0.1:${fake.port}`);
      expect(health).not.toBeNull();
      expect(health?.mock).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it('fails closed for a live server (mock: false)', async () => {
    const fake = await startFakeServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, mock: false, chargersSeen: 0 }));
    });
    try {
      const health = await probeHealth(`http://127.0.0.1:${fake.port}`);
      expect(health?.mock).toBe(false); // the launcher must refuse this
    } finally {
      await fake.close();
    }
  });

  it('returns null when nothing answers', async () => {
    const health = await probeHealth('http://127.0.0.1:1');
    expect(health).toBeNull();
  });
});

describe('probeSyntheticPlan (synthetic gate)', () => {
  it('accepts only plans labelled synthetic with stops', async () => {
    const fake = await startFakeServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/plan') {
        res.end(JSON.stringify({ plan: { source: 'synthetic', stops: [{}] } }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    try {
      expect(await probeSyntheticPlan(`http://127.0.0.1:${fake.port}`)).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it('rejects live plans and error responses', async () => {
    const fake = await startFakeServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/plan') {
        res.end(JSON.stringify({ plan: { source: 'live', stops: [{}] } }));
      } else {
        res.statusCode = 500;
        res.end('{}');
      }
    });
    try {
      expect(await probeSyntheticPlan(`http://127.0.0.1:${fake.port}`)).toBe(false);
    } finally {
      await fake.close();
    }
  });
});

describe('ui-verify launcher (integration)', () => {
  it(
    'boots isolated mock stack and prints READY only after fail-closed gates pass',
    { timeout: 120_000 },
    async () => {
      // Regression: the parent env carries live credentials and AI config;
      // the launcher must strip them from BOTH children and still reach READY.
      const envWithCredentials: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) envWithCredentials[k] = v;
      }
      envWithCredentials.STATIQ_API_TOKEN = 'sk-live-should-never-pass-through';
      envWithCredentials.AI_BASE_URL = 'https://ai.test/v1';
      envWithCredentials.AI_API_KEY = 'sk-ai-live';
      envWithCredentials.AI_MODEL = 'test-model';

      // isolated DYNAMIC ports for this test run (never 8787/5173, and
      // never a fixed port that a PARALLEL suite can share - the proven
      // 8891 sharing that caused the acceptance provenance race)
      const srvPort = await freePort();
      const webPort = await freePort();
      const child = spawn(process.execPath, [join('scripts', 'ui-verify.mjs')], {
        cwd: ROOT,
        env: {
          ...envWithCredentials,
          UIV_SERVER_PORT: String(srvPort),
          UIV_WEB_PORT: String(webPort),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let errOut = '';
      child.stdout.on('data', (d) => {
        out += String(d);
      });
      child.stderr.on('data', (d) => {
        errOut += String(d);
      });

      const ready = await new Promise<boolean>((resolveReady) => {
        const check = setInterval(() => {
          if (out.includes('READY ui-verify:')) {
            clearInterval(check);
            clearTimeout(fail);
            resolveReady(true);
          }
        }, 500);
        const fail = setTimeout(() => {
          clearInterval(check);
          resolveReady(false);
        }, 90_000);
        child.on('exit', (code) => {
          clearInterval(check);
          clearTimeout(fail);
          if (!out.includes('READY ui-verify:')) {
            resolveReady(false);
            void code;
          }
        });
      });

      try {
        expect(
          ready,
          `launcher did not reach READY. stdout: ${out.slice(0, 2000)} stderr: ${errOut.slice(0, 2000)}`,
        ).toBe(true);

        // Regression (finding 4): READY was reached even though the parent
        // carried live credentials - and the launcher reports they were
        // stripped from the children.
        expect(out).toContain('credential-free stack');
        expect(out).not.toContain('sk-live-should-never-pass-through');

        // Independent assertions of the gates:
        const health = await probeHealth(`http://localhost:${srvPort}`);
        expect(health?.mock).toBe(true);
        const synthetic = await probeSyntheticPlan(`http://localhost:${srvPort}`);
        expect(synthetic).toBe(true);
        const webRes = await fetch(`http://localhost:${webPort}/`);
        expect(webRes.ok).toBe(true);
      } finally {
        child.kill('SIGTERM');
        await once(child, 'exit').catch(() => {});
      }
    },
  );
});

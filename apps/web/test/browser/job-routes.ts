/**
 * Browser fixture bridge: the AI submit now goes through job start + status
 * polling instead of a single /api/ai/plan call. Specs keep expressing the
 * AI envelope they want; this helper serves it over the job endpoints with
 * a transient capability that never leaves the fixture.
 */
import type { Page } from '@playwright/test';

export interface JobAnswer {
  status?: number;
  json: unknown;
}

export interface JobRouteOptions {
  /** Hold the start request to assert the busy state before it settles. */
  holdFirstStart?: Promise<void>;
  /** Return a failing DELETE to prove cancellation is never assumed. */
  cancelShouldFail?: boolean;
  /** Make status polling fail so the UI must treat the run as unknown. */
  statusShouldFail?: boolean;
  /** Progressive status bodies (poll number, 1-based). Return null to
   *  simulate a job lost to a server restart. */
  statuses?: (poll: number) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
}

export async function installAiJobRoutes(
  page: Page,
  respond: (body: unknown, call: number) => JobAnswer | Promise<JobAnswer>,
  options: JobRouteOptions = {},
): Promise<void> {
  const capability = 'fixture-capability';
  const answers = new Map<string, JobAnswer>();
  let call = 0;
  let poll = 0;

  await page.route('**/api/jobs/plan', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    call += 1;
    const body = route.request().postDataJSON();
    if (options.holdFirstStart && call === 1) await options.holdFirstStart;
    const answer = await respond(body, call);
    if ((answer.status ?? 200) >= 400) {
      return route.fulfill({ status: answer.status ?? 500, contentType: 'application/json', body: JSON.stringify(answer.json) });
    }
    const jobId = `job-${call}`;
    answers.set(jobId, answer);
    return route.fulfill({
      status: 202,
      json: { jobId, capability, budget: { deadlineMs: 60_000, maxUpstreamCalls: 10 } },
    });
  });

  await page.route('**/api/jobs/plan/*', async (route) => {
    if (route.request().method() === 'DELETE') {
      if (options.cancelShouldFail) {
        return route.fulfill({ status: 503, json: { error: 'Cancellation unavailable', code: 'cancel_failed' } });
      }
      return route.fulfill({ status: 200, json: { cancelled: true } });
    }
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '');
    if ((await route.request().headerValue('x-job-capability')) !== capability) {
      return route.fulfill({ status: 404, json: { error: 'Job not found', code: 'job_not_found' } });
    }
    poll += 1;
    if (options.statusShouldFail) {
      return route.fulfill({ status: 503, json: { error: 'Status unavailable', code: 'status_unavailable' } });
    }
    if (options.statuses) {
      const body = await options.statuses(poll);
      if (body === null) {
        return route.fulfill({ status: 404, json: { error: 'Job not found', code: 'job_not_found' } });
      }
      return route.fulfill({ status: 200, json: body });
    }
    const answer = answers.get(id);
    if (!answer) {
      return route.fulfill({ status: 404, json: { error: 'Job not found', code: 'job_not_found' } });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jobId: id,
        state: 'succeeded',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        progress: null,
        result: answer.json,
      }),
    });
  });
}

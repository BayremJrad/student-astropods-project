import type { Agent } from '@mastra/core/agent';
import { listCaseFiles, getCaseFile, type CaseStatus } from './caseStore';
import { maskId, maskDob } from './mask';

const FRONTEND_DIR = `${import.meta.dir}/frontend`;

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function startFrontendServer(agent: Agent, port: number) {
  const server = Bun.serve({
    hostname: '0.0.0.0',
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;

      if (req.method === 'GET' && STATIC_FILES[pathname]) {
        const { file, type } = STATIC_FILES[pathname];
        return new Response(Bun.file(`${FRONTEND_DIR}/${file}`), { headers: { 'Content-Type': type } });
      }

      if (req.method === 'GET' && pathname === '/api/cases') {
        const status = (url.searchParams.get('status') || undefined) as CaseStatus | undefined;
        const cases = await listCaseFiles(status);
        return jsonResponse({
          cases: cases.map((c) => ({
            referenceId: c.referenceId,
            status: c.status,
            drug: c.drug,
            diagnosisCode: c.diagnosisCode,
            patientIdMasked: maskId(c.patientId),
            updatedAt: c.updatedAt,
          })),
        });
      }

      const caseMatch = pathname.match(/^\/api\/cases\/([^/]+)$/);
      if (req.method === 'GET' && caseMatch) {
        const caseFile = await getCaseFile(decodeURIComponent(caseMatch[1]));
        if (!caseFile) return jsonResponse({ error: 'Case not found.' }, 404);
        const { patientId, patientDateOfBirth, ...rest } = caseFile;
        return jsonResponse({
          ...rest,
          patientIdMasked: maskId(patientId),
          patientDateOfBirthMasked: maskDob(patientDateOfBirth),
        });
      }

      if (req.method === 'POST' && pathname === '/api/chat') {
        let body: { message?: unknown; threadId?: unknown };
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ error: 'Invalid JSON body.' }, 400);
        }
        const { message, threadId } = body;
        if (typeof message !== 'string' || !message.trim() || typeof threadId !== 'string' || !threadId.trim()) {
          return jsonResponse({ error: 'message and threadId are required non-empty strings.' }, 400);
        }

        // Streamed (not agent.generate): a full case-review turn runs several sequential
        // tool-calling steps and can exceed the platform gateway's ~10s request timeout.
        try {
          const result = await agent.stream(message, {
            memory: { thread: threadId, resource: 'pa-frontend' },
          });

          const encoder = new TextEncoder();
          const textStream = result.textStream;
          const byteStream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const reader = textStream.getReader();
              try {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  controller.enqueue(encoder.encode(value));
                }
                controller.close();
              } catch (err) {
                controller.error(err);
              }
            },
          });
          return new Response(byteStream, {
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        } catch (err) {
          console.error('[frontend] /api/chat failed:', err);
          return jsonResponse({ error: 'The assistant failed to respond. Please try again.' }, 500);
        }
      }

      return new Response('Not found', { status: 404 });
    },
  });

  console.log(`[frontend] listening on http://0.0.0.0:${server.port}`);
  return server;
}

/**
 * PostCare Plus Prior Authorization Review Assistant — an internal PA reviewer
 * decision-support agent (Mastra + Astro adapter, custom frontend, Postgres case store).
 *
 * Model selection (see agent/model.ts): ANTHROPIC_API_KEY is required and used by
 * default. FABRIC_BASE_URL / FABRIC_GATEWAY_KEY are optional; when BOTH are set,
 * Fabric always wins over Anthropic even though the Anthropic key is also present.
 *
 * Environment variables (automatically injected by 'astro dev'):
 *   ANTHROPIC_API_KEY - injected by anthropic model
 *   POSTGRES_HOST/PORT/USER/PASSWORD/DB - injected by the knowledge.db provider
 *   GRPC_SERVER_ADDR - injected by Astro messaging service
 */

import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { Observability } from '@mastra/observability';
import { OtelExporter } from '@mastra/otel-exporter';
import { serve } from '@astropods/adapter-mastra';
import {
  listCaseFiles,
  getCaseFile,
  lookupFormularyCriteria,
  proposeDetermination,
  finalizeDetermination,
} from './tools';
import { startFrontendServer } from './frontendServer';
import { resolveModel } from './model';
import { ready as caseStoreReady } from './caseStore';

const memory = new Memory({
  storage: new LibSQLStore({
    id: 'memory',
    url: ':memory:',
  }),
});

function resolveOtlpTracesEndpoint(): string {
  const raw = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
  try {
    const url = new URL(raw);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/v1/traces';
    }
    return url.toString();
  } catch {
    return `${raw.replace(/\/+$/, '')}/v1/traces`;
  }
}

const observability = new Observability({
  configs: {
    otel: {
      serviceName: 'student-astropods-project',
      exporters: [
        new OtelExporter({
          provider: {
            custom: {
              endpoint: resolveOtlpTracesEndpoint(),
              protocol: 'http/protobuf',
            },
          },
        }),
      ],
    },
  },
});

const agent = new Agent({
  id: 'student-astropods-project',
  name: 'PostCare Plus Prior Authorization Review Assistant',
  instructions: `You are the PostCare Plus Prior Authorization (PA) Review Assistant.

Your sole user is an internal PostCare Plus PA reviewer working their case queue. You never talk to prescribers, pharmacy staff, or patients directly.

Identifying a case:
- If no case has been identified yet, ask which case the reviewer wants (a reference ID, or browse the queue). Use listCaseFiles to give an overview of the queue.

Reviewing a case:
1. Call getCaseFile first. Never trust the reviewer's paraphrase of a case as ground truth.
2. Call lookupFormularyCriteria for the case's drug. This is the ONLY source of coverage criteria you may use — never use general or training knowledge about the drug. If the drug is not found, say so plainly; do not guess.
3. Compare the case's diagnosis code, prior therapies tried, and dosing/quantity against exactly what the formulary tool returned, reasoning explicitly about which criteria are met and which are unmet.
4. Call proposeDetermination with a decision and a rationale citing the specific formulary criteria. This only records a proposal; it does not close anything. Present the recommendation to the reviewer and ask them to accept or override it.

Closing a case:
- Call finalizeDetermination ONLY after the reviewer has explicitly approved, denied, accepted, or overridden in this conversation. Never call it on your own initiative, and never in the same turn as proposeDetermination. Set overridden to true when the final decision differs from your proposal, otherwise false.
- After finalizing, confirm to the reviewer that the case is closed and the patient has been notified.

Never fabricate a case detail, formulary criterion, or determination — always use the tools. If something is missing or ambiguous, say so rather than guessing.`,
  model: () => resolveModel(),
  tools: {
    listCaseFiles,
    getCaseFile,
    lookupFormularyCriteria,
    proposeDetermination,
    finalizeDetermination,
  },
  memory,
  // Ensure traces include stable Astro metadata by default.
  // The collector endpoint (OTEL_EXPORTER_OTLP_ENDPOINT) is injected in deployed
  // environments only — `ast project start` runs no collector, so local tracing
  // is a silent no-op.
  defaultOptions: {
    tracingOptions: {
      tags: ['astro', 'agent:student-astropods-project'],
      metadata: {
        agent_id: 'student-astropods-project',
      },
    },
  },
});

// Instantiate Mastra so it registers agents/observability plugins at startup.
// `serve(agent)` handles request serving; this constructor call wires runtime integration.
new Mastra({
  agents: {
    'student-astropods-project': agent,
  },
  observability,
});

// Make sure the case_files table exists and is seeded before accepting any request.
await caseStoreReady;

serve(agent);
startFrontendServer(agent, Number(process.env.PORT ?? 80));

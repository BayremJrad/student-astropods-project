/**
 * Case-file persistence, backed by the Postgres knowledge store declared in
 * astropods.yml (`knowledge.db`). The platform injects POSTGRES_HOST/PORT/
 * USER/PASSWORD/DB for that entry. One JSONB blob per row, keyed by referenceId.
 */

import { Pool } from 'pg';
import { CASE_FILE_SEED } from './data/caseFiles';

export type CaseStatus = 'pending' | 'approved' | 'denied';
export type DeterminationDecision = 'approved' | 'denied';

export interface Determination {
  decision: DeterminationDecision;
  rationale: string;
  citedDrug: string;
  timestamp: string;
}

export interface FinalDetermination extends Determination {
  overridden: boolean;
}

export interface CaseFile {
  referenceId: string;
  status: CaseStatus;
  createdAt: string;
  updatedAt: string;
  drug: string;
  dosage: string;
  quantity: string;
  daysSupply: number;
  diagnosisCode: string;
  priorTherapiesTried: string;
  patientId: string;
  patientDateOfBirth: string;
  prescriberName: string;
  prescriberNpi: string;
  prescriberContact: string;
  pharmacyOrFacility: string;
  proposedDetermination: Determination | null;
  finalDetermination: FinalDetermination | null;
  patientNotifiedAt: string | null;
}

const pool = new Pool({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: parseInt(process.env.POSTGRES_PORT ?? '5432'),
  database: process.env.POSTGRES_DB ?? 'postgres',
  user: process.env.POSTGRES_USER ?? 'postgres',
  password: process.env.POSTGRES_PASSWORD ?? 'postgres',
});

async function ensureTable(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS case_files (
       "referenceId" TEXT PRIMARY KEY,
       data JSONB NOT NULL
     )`
  );
}

export async function seedIfEmpty(seed: CaseFile[]): Promise<void> {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM case_files');
  if (rows[0].count > 0) return;
  for (const caseFile of seed) {
    await saveCaseFile(caseFile);
  }
}

export async function listCaseFiles(status?: CaseStatus): Promise<CaseFile[]> {
  const { rows } = status
    ? await pool.query(
        `SELECT data FROM case_files WHERE data->>'status' = $1 ORDER BY "referenceId"`,
        [status]
      )
    : await pool.query(`SELECT data FROM case_files ORDER BY "referenceId"`);
  return rows.map((r) => r.data as CaseFile);
}

export async function getCaseFile(referenceId: string): Promise<CaseFile | null> {
  const { rows } = await pool.query(`SELECT data FROM case_files WHERE "referenceId" = $1`, [referenceId]);
  return rows.length ? (rows[0].data as CaseFile) : null;
}

export async function saveCaseFile(caseFile: CaseFile): Promise<void> {
  await pool.query(
    `INSERT INTO case_files ("referenceId", data) VALUES ($1, $2)
     ON CONFLICT ("referenceId") DO UPDATE SET data = EXCLUDED.data`,
    [caseFile.referenceId, JSON.stringify(caseFile)]
  );
}

/** Resolves once the table exists and the seed has run. Await before serving traffic. */
export const ready: Promise<void> = ensureTable().then(() => seedIfEmpty(CASE_FILE_SEED));

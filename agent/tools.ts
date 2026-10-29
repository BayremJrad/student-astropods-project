import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  listCaseFiles as storeListCaseFiles,
  getCaseFile as storeGetCaseFile,
  saveCaseFile,
  type Determination,
  type FinalDetermination,
} from './caseStore';
import { lookupFormularyEntry } from './data/formulary';
import { maskId, maskDob } from './mask';

const statusEnum = z.enum(['pending', 'approved', 'denied']);
const decisionEnum = z.enum(['approved', 'denied']);

export const listCaseFiles = createTool({
  id: 'list-case-files',
  description:
    "Lists case files in the reviewer's queue, optionally filtered by status. Use when the reviewer wants an overview of their queue instead of naming a specific case.",
  inputSchema: z.object({ status: statusEnum.optional() }),
  outputSchema: z.object({
    cases: z.array(
      z.object({
        referenceId: z.string(),
        status: statusEnum,
        drug: z.string(),
        diagnosisCode: z.string(),
        patientIdMasked: z.string(),
        updatedAt: z.string(),
      })
    ),
  }),
  execute: async (inputData) => {
    const cases = await storeListCaseFiles(inputData.status);
    return {
      cases: cases.map((c) => ({
        referenceId: c.referenceId,
        status: c.status,
        drug: c.drug,
        diagnosisCode: c.diagnosisCode,
        patientIdMasked: maskId(c.patientId),
        updatedAt: c.updatedAt,
      })),
    };
  },
});

export const getCaseFile = createTool({
  id: 'get-case-file',
  description:
    "Fetches the full case file for a reference ID. Always call this before reasoning about a case; never trust the reviewer's paraphrase as ground truth.",
  inputSchema: z.object({ referenceId: z.string() }),
  outputSchema: z.object({
    found: z.boolean(),
    caseFile: z.record(z.string(), z.any()).nullable(),
  }),
  execute: async (inputData) => {
    const caseFile = await storeGetCaseFile(inputData.referenceId);
    if (!caseFile) return { found: false, caseFile: null };
    return {
      found: true,
      caseFile: {
        ...caseFile,
        patientIdMasked: maskId(caseFile.patientId),
        patientDateOfBirthMasked: maskDob(caseFile.patientDateOfBirth),
      },
    };
  },
});

export const lookupFormularyCriteria = createTool({
  id: 'lookup-formulary-criteria',
  description:
    'Looks up PostCare Plus formulary coverage criteria for a drug. This is the ONLY source of coverage criteria you may use — never reason from general/training knowledge about a drug. If not found, say so plainly.',
  inputSchema: z.object({ drug: z.string() }),
  outputSchema: z.object({
    found: z.boolean(),
    entry: z.record(z.string(), z.any()).nullable(),
  }),
  execute: async (inputData) => {
    const entry = lookupFormularyEntry(inputData.drug);
    return { found: entry !== null, entry };
  },
});

export const proposeDetermination = createTool({
  id: 'propose-determination',
  description:
    'Records a proposed approve/deny determination with rationale on a case. Does NOT close the case. Only call after checking both getCaseFile and lookupFormularyCriteria.',
  inputSchema: z.object({
    referenceId: z.string(),
    decision: decisionEnum,
    rationale: z.string(),
  }),
  outputSchema: z.object({
    referenceId: z.string(),
    proposedDetermination: z.record(z.string(), z.any()),
  }),
  execute: async (inputData) => {
    const caseFile = await storeGetCaseFile(inputData.referenceId);
    if (!caseFile) throw new Error(`Case ${inputData.referenceId} not found.`);

    const now = new Date().toISOString();
    const proposed: Determination = {
      decision: inputData.decision,
      rationale: inputData.rationale,
      citedDrug: caseFile.drug,
      timestamp: now,
    };
    caseFile.proposedDetermination = proposed;
    caseFile.updatedAt = now;
    await saveCaseFile(caseFile);

    return { referenceId: caseFile.referenceId, proposedDetermination: proposed };
  },
});

export const finalizeDetermination = createTool({
  id: 'finalize-determination',
  description:
    'Closes a case with the reviewer\'s final determination and notifies the patient (stubbed). ONLY call this after the human reviewer has explicitly told you, in this conversation, to approve/deny/accept/override — never on your own initiative, and never in the same turn as proposeDetermination.',
  inputSchema: z.object({
    referenceId: z.string(),
    decision: decisionEnum,
    rationale: z.string(),
    overridden: z.boolean(),
  }),
  outputSchema: z.object({
    referenceId: z.string(),
    status: statusEnum,
    finalDetermination: z.record(z.string(), z.any()),
    patientNotifiedAt: z.string(),
  }),
  execute: async (inputData) => {
    const caseFile = await storeGetCaseFile(inputData.referenceId);
    if (!caseFile) throw new Error(`Case ${inputData.referenceId} not found.`);

    const now = new Date().toISOString();
    const final: FinalDetermination = {
      decision: inputData.decision,
      rationale: inputData.rationale,
      citedDrug: caseFile.drug,
      timestamp: now,
      overridden: inputData.overridden,
    };

    console.log(
      `[notify-patient] Case ${caseFile.referenceId} (${caseFile.drug}) determination: ${inputData.decision}. Notifying patient ${maskId(caseFile.patientId)}.`
    );

    caseFile.status = inputData.decision;
    caseFile.finalDetermination = final;
    caseFile.patientNotifiedAt = now;
    caseFile.updatedAt = now;
    await saveCaseFile(caseFile);

    return {
      referenceId: caseFile.referenceId,
      status: caseFile.status,
      finalDetermination: final,
      patientNotifiedAt: now,
    };
  },
});

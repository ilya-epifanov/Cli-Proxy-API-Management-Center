/**
 * Server-side quota reads of the fork (`observability.quota`): `GET /quota/probes` returns the
 * latest upstream answers per account without contacting a provider; `POST /quota/probes/refresh`
 * reads one account now, unless the server read it within its minimum interval.
 *
 * The answers are the providers' raw responses, so the quota adapters parse them with the same
 * code as a direct read through `/requests/api-call`.
 */

import { apiClient } from './client';
import { toApiCallResult, type ApiCallResult } from './apiCall';
import { ShapeReader } from './responseShape';

export interface QuotaProbeFailure {
  /** Upstream HTTP status; null when the request did not complete. */
  status: number | null;
  message: string;
}

export interface QuotaProbeEntry {
  authIndex: string;
  /** Latest successful read; epoch ms, null before the first one. */
  fetchedAt: number | null;
  /** Set when the latest read failed; `responses` then hold the last successful read. */
  error: QuotaProbeFailure | null;
  /** Upstream answers by request name ("usage", "profile", …). */
  responses: ReadonlyMap<string, ApiCallResult>;
}

/** Refreshes wait in the server's single queue behind other accounts. */
const REFRESH_TIMEOUT_MS = 90_000;

const parseEntry = (reader: ShapeReader, value: unknown, path: string): QuotaProbeEntry => {
  const entry = reader.record(value, path);
  const failure =
    entry.error === null || entry.error === undefined
      ? null
      : reader.record(entry.error, `${path}.error`);
  const responses = new Map<string, ApiCallResult>();
  Object.entries(reader.record(entry.responses ?? {}, `${path}.responses`)).forEach(
    ([name, raw]) => {
      const response = reader.record(raw, `${path}.responses.${name}`);
      responses.set(
        name,
        toApiCallResult(
          reader.count(response.status_code, `${path}.responses.${name}.status_code`),
          reader.string(response.body, `${path}.responses.${name}.body`)
        )
      );
    }
  );
  return {
    authIndex: reader.string(entry.auth_index, `${path}.auth_index`),
    fetchedAt:
      entry.fetched_at === null || entry.fetched_at === undefined
        ? null
        : reader.instant(entry.fetched_at, `${path}.fetched_at`),
    error: failure && {
      status:
        failure.status === undefined ? null : reader.count(failure.status, `${path}.error.status`),
      message: reader.string(failure.message, `${path}.error.message`),
    },
    responses,
  };
};

const listReader = new ShapeReader('GET /quota/probes');
const refreshReader = new ShapeReader('POST /quota/probes/refresh');

export function parseQuotaProbes(payload: unknown): QuotaProbeEntry[] {
  const body = listReader.record(payload, 'body');
  return listReader
    .array(body.entries, 'entries')
    .map((entry, index) => parseEntry(listReader, entry, `entries[${index}]`));
}

export function parseQuotaProbeRefresh(payload: unknown): QuotaProbeEntry {
  return parseEntry(refreshReader, payload, 'body');
}

export const quotaProbesApi = {
  /** Every account's latest read. */
  async list(): Promise<QuotaProbeEntry[]> {
    return parseQuotaProbes(await apiClient.get<unknown>('/quota/probes'));
  },

  async refresh(authIndex: string): Promise<QuotaProbeEntry> {
    const payload = await apiClient.post<unknown>(
      '/quota/probes/refresh',
      { auth_index: authIndex },
      { timeout: REFRESH_TIMEOUT_MS }
    );
    return parseQuotaProbeRefresh(payload);
  },
};

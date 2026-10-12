/**
 * 额度提供商适配器 = 数据层（data.ts，React-free）+ 渲染体（*QuotaBody.tsx）。
 *
 * 页面侧以擦除泛型的 QuotaAdapter 视图统一消费（与 AuthFileQuotaSection 的
 * 窄接口 cast 同一模式）；具体状态类型由各 data.ts 的强类型导出承载。
 */

import type { ComponentType } from 'react';
import type { TFunction } from 'i18next';
import { quotaProbesApi, serverReadsQuota, type QuotaProbeEntry } from '@/services/api';
import { useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import type { QuotaBodyProps } from '../types';
import type { QuotaProviderType, QuotaStore } from './types';
import { ANTIGRAVITY_CONFIG } from './antigravity/data';
import { AntigravityQuotaBody } from './antigravity/AntigravityQuotaBody';
import { CLAUDE_CONFIG } from './claude/data';
import { ClaudeQuotaBody } from './claude/ClaudeQuotaBody';
import { DEVIN_CONFIG } from './devin/data';
import { DevinQuotaBody } from './devin/DevinQuotaBody';
import { CODEX_CONFIG } from './codex/data';
import { CodexQuotaBody } from './codex/CodexQuotaBody';
import { META_CONFIG } from './meta/data';
import { MetaQuotaBody } from './meta/MetaQuotaBody';
import { KIMI_CONFIG } from './kimi/data';
import { KimiQuotaBody } from './kimi/KimiQuotaBody';
import { PLUGIN_CONFIG } from './plugin/data';
import { PluginQuotaBody } from './plugin/PluginQuotaBody';
import { XAI_CONFIG } from './xai/data';
import { XaiQuotaBody } from './xai/XaiQuotaBody';

/** 所有 provider 额度状态的公共骨架（各 *QuotaState 的结构子集）。 */
export interface QuotaCardState {
  status: 'idle' | 'loading' | 'success' | 'error';
  error?: string;
  errorStatus?: number;
}

export interface QuotaAdapter {
  type: QuotaProviderType;
  i18nPrefix: string;
  filterFn: (file: AuthFileItem) => boolean;
  fetchQuota: (file: AuthFileItem, t: TFunction) => Promise<unknown>;
  fromServerProbe?: (file: AuthFileItem, entry: QuotaProbeEntry, t: TFunction) => unknown;
  enrichQuota?: (file: AuthFileItem, data: unknown, t: TFunction) => Promise<unknown>;
  resetQuota?: (file: AuthFileItem, t: TFunction) => Promise<unknown>;
  canResetQuota?: (quota: QuotaCardState) => boolean;
  storeSelector: (state: QuotaStore) => Record<string, QuotaCardState>;
  storeSetter: keyof QuotaStore;
  buildLoadingState: () => QuotaCardState;
  buildSuccessState: (data: unknown) => QuotaCardState;
  buildErrorState: (message: string, status?: number) => QuotaCardState;
  Body: ComponentType<QuotaBodyProps<QuotaCardState>>;
}

/** A provider's data layer and body, before the registry adds its read path. */
type ProviderAdapter = Omit<QuotaAdapter, 'resetQuota'> & {
  consumeReset?: (file: AuthFileItem, t: TFunction) => Promise<void>;
};

/**
 * Chooses how a provider's quota is read. When the provider can use the server's reads and the
 * server reads quota itself, every read goes through `POST /quota/probes/refresh`, so the
 * server's schedule and rate limit cover all of them; otherwise the provider reads directly.
 * A spent reset is followed by a read on the same path.
 */
function withReadPath(provider: ProviderAdapter): QuotaAdapter {
  const { consumeReset, fromServerProbe, ...adapter } = provider;
  const fetchQuota: QuotaAdapter['fetchQuota'] = async (file, t) => {
    if (!fromServerProbe || !(await serverReadsQuota())) return provider.fetchQuota(file, t);
    const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
    if (!authIndex) throw new Error(t(`${provider.i18nPrefix}.missing_auth_index`));
    return fromServerProbe(file, await quotaProbesApi.refresh(authIndex), t);
  };
  return {
    ...adapter,
    fromServerProbe,
    fetchQuota,
    resetQuota:
      consumeReset &&
      (async (file, t) => {
        await consumeReset(file, t);
        return fetchQuota(file, t);
      }),
  };
}

const provider = (config: unknown, Body: unknown): QuotaAdapter =>
  withReadPath({ ...(config as ProviderAdapter), Body: Body as ProviderAdapter['Body'] });

export const QUOTA_ADAPTERS: Record<QuotaProviderType, QuotaAdapter> = {
  antigravity: provider(ANTIGRAVITY_CONFIG, AntigravityQuotaBody),
  claude: provider(CLAUDE_CONFIG, ClaudeQuotaBody),
  codex: provider(CODEX_CONFIG, CodexQuotaBody),
  devin: provider(DEVIN_CONFIG, DevinQuotaBody),
  kimi: provider(KIMI_CONFIG, KimiQuotaBody),
  meta: provider(META_CONFIG, MetaQuotaBody),
  plugin: provider(PLUGIN_CONFIG, PluginQuotaBody),
  xai: provider(XAI_CONFIG, XaiQuotaBody),
};

export type QuotaMapUpdater = (
  updater: (prev: Record<string, QuotaCardState>) => Record<string, QuotaCardState>
) => void;

/** 取 adapter 对应的 store setter（getState 直读，不建立订阅）。 */
export const getQuotaSetter = (adapter: QuotaAdapter): QuotaMapUpdater =>
  useQuotaStore.getState()[adapter.storeSetter] as unknown as QuotaMapUpdater;

/** 取 adapter 对应的额度缓存快照（getState 直读，不建立订阅）。 */
export const getQuotaMap = (adapter: QuotaAdapter): Record<string, QuotaCardState> =>
  adapter.storeSelector(useQuotaStore.getState() as unknown as QuotaStore);

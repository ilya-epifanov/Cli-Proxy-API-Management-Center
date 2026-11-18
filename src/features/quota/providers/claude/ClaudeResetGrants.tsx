import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { useAuthStore } from '@/stores/useAuthStore';
import { useNotificationStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import { serverReadsQuota } from '@/services/api/capabilities';
import {
  AnthropicResetGrantError,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/quota';
import {
  resetGrantOperations,
  RETRY_WINDOW_MS,
  ResetGrantPreflightError,
  resetGrantFailureMessageKey,
} from './resetGrantOperations';
import { canChooseResetGrant } from './resetGrantChoice';
import { readResetGrantsForCard, scheduleResetGrantRead } from './resetGrantReads';

/** Card-owned reads; the session-scoped journal owns spending and ambiguous retries. */
export function useClaudeResetGrants(
  file: AuthFileItem,
  enabled: boolean,
  disabled: boolean,
  refreshToken: unknown,
  onRefresh: () => void,
  /** Status from the server's quota read; undefined when the card reads it directly. */
  serverStatus: AnthropicResetGrantStatus | null | undefined
) {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const [session] = useState(() => apiClient.getConnectionRevision());
  const sessionActive =
    connectionStatus === 'connected' && session === apiClient.getConnectionRevision();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const now = useNow();
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  const key = JSON.stringify([file.name, authIndex]);
  const [readStatus, setReadStatus] = useState<AnthropicResetGrantStatus | null>(null);
  const [readMessage, setReadMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [dialog, setDialog] = useState<{ key: string; selected: string | null } | null>(null);
  const lock = useRef(false);
  const generation = useRef(0);
  const active = enabled && !disabled && sessionActive && Boolean(authIndex);
  const fromServer = serverStatus !== undefined;
  useEffect(() => {
    const version = ++generation.current;
    setReadStatus(null);
    // A server that reads quota reads the grant status with it; without that status, there is
    // nothing to show, and reading directly would bypass the server's rate limit.
    if (!active || fromServer || !authIndex) return;
    let cancelled = false;
    const current = () =>
      !cancelled && version === generation.current && session === apiClient.getConnectionRevision();
    const cancelRead = scheduleResetGrantRead(() => {
      void serverReadsQuota()
        .then((serverReads) => (serverReads ? null : readResetGrantsForCard(authIndex)))
        .then(
          (result) => {
            if (!current()) return;
            setReadStatus(result);
            setReadMessage(result ? '' : 'read_error');
          },
          (error: unknown) => {
            if (current()) {
              setReadMessage(
                error instanceof AnthropicResetGrantError && error.code === 'rate_limited'
                  ? 'rate_limited'
                  : 'read_error'
              );
            }
          }
        );
    }, current);
    return () => {
      cancelled = true;
      cancelRead();
      generation.current += 1;
    };
  }, [authIndex, key, active, fromServer, serverStatus, session, refreshToken, reload]);
  const status = active ? (fromServer ? serverStatus : readStatus) : null;
  const message = active && fromServer ? (serverStatus ? '' : 'read_error') : readMessage;

  const operation = resetGrantOperations.inspect(key);
  const pending = operation && !operation.code ? operation : undefined;
  const grants = [...(status?.grants ?? [])];
  if (pending && !grants.some((grant) => grant.id === pending.grantId)) grants.push(pending.grant);
  const expired = Boolean(pending && now - pending.createdAt >= RETRY_WINDOW_MS);
  const blocked = !enabled || disabled || !sessionActive || !authIndex || busy || expired;
  const canRedeemGrant = (grantId: unknown) =>
    !blocked && canChooseResetGrant(status, pending?.grantId, grantId, now);
  const open = Boolean(dialog && dialog.key === key && sessionActive && enabled);
  const selected = open ? (dialog?.selected ?? null) : null;
  const confirm = async () => {
    if (!open || !selected || !canRedeemGrant(selected) || lock.current || !authIndex) return;
    const version = generation.current;
    const current = () =>
      session === apiClient.getConnectionRevision() && version === generation.current;
    if (!current() || useAuthStore.getState().connectionStatus !== 'connected') return;
    lock.current = true;
    setBusy(true);
    try {
      const answer = await resetGrantOperations.run(key, authIndex, selected);
      if (!current()) return;
      if (
        !answer.unresolved &&
        (answer.code === 'reset' ||
          answer.code === 'already_used' ||
          answer.code === 'cooldown_clear_failed')
      ) {
        setDialog(null);
      }
      showNotification(
        answer.code === 'cooldown_clear_failed'
          ? t('auth_files.cooldown_reset_failed', {
              name: file.name,
              message: t('common.unknown_error'),
            })
          : t(`claude_reset.${answer.unresolved ? 'unknown' : answer.code}`),
        !answer.unresolved && (answer.code === 'reset' || answer.code === 'already_used')
          ? 'success'
          : 'error'
      );
    } catch (error: unknown) {
      if (!current()) return;
      const unresolved = resetGrantOperations.inspect(key);
      showNotification(
        t(
          unresolved && !unresolved.code
            ? 'claude_reset.unknown'
            : resetGrantFailureMessageKey(error),
          {
            code: error instanceof ResetGrantPreflightError ? error.reason : '',
          }
        ),
        'error'
      );
    } finally {
      lock.current = false;
      // A concurrent page-wide refresh can invalidate this read generation.
      // Release the local lock regardless, but never refresh a replacement account.
      setBusy(false);
      setReload((value) => value + 1);
      if (current()) onRefresh();
    }
  };
  return {
    count: status?.grants.reduce((sum, grant) => sum + grant.resetsLeft, 0) ?? null,
    grants,
    loading: !status && !message && !pending,
    open,
    selected,
    openDialog: () => {
      if (!blocked && !lock.current) setDialog({ key, selected: null });
    },
    closeDialog: () => {
      if (!lock.current) setDialog(null);
    },
    selectGrant: (grantId: string) => {
      if (open && canRedeemGrant(grantId) && !lock.current) setDialog({ key, selected: grantId });
    },
    blocked,
    buttonLabel: pending ? 'retry' : 'use',
    pendingGrantId: pending?.grantId,
    canRedeemGrant,
    busy,
    confirm,
    message: pending ? (expired ? 'expired' : 'unknown') : message,
  };
}

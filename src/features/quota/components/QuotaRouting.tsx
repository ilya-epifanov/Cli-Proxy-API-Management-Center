/**
 * Routing on a Quota card: where the pace selector ranks the account for new sessions and why.
 * The drain checkbox and rank chip sit in the card header; the routing notes sit under it.
 */

import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useNow } from '@/hooks/useNow';
import type { PoolRanking } from '@/services/api';
import type { AuthFileItem } from '@/types';
import type { QuotaTabId } from '../constants';
import { poolRunwayLines, routingNotes, routingRankTitle, type CardRouting } from '../routing';
import styles from './QuotaCard.module.scss';
import routingStyles from './QuotaRouting.module.scss';

/** `#2/5`, highlighted when a new session may land on this account. */
export function RoutingRank({ routing }: { routing: CardRouting }) {
  const { t } = useTranslation();
  if (routing.tag !== 'ranked') return null;
  const { entry, poolSize } = routing;
  const title = routingRankTitle(t, entry, poolSize);
  return (
    <span
      className={`${styles.routingRank} ${entry.topBand ? styles.routingRankNext : ''}`}
      title={title}
      aria-label={title}
    >
      #{entry.rank}
      <span className={styles.routingRankTotal} aria-hidden="true">
        /{poolSize}
      </span>
    </span>
  );
}

/** Flags or unflags an account to be used first. */
export type DrainChange = (authIndex: string, drain: boolean) => Promise<void>;

/** The checkbox follows the ranking: the server clears the flag when the account runs out. */
export function RoutingDrain({
  routing,
  onChange,
}: {
  routing: CardRouting;
  onChange: DrainChange;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  if (routing.tag !== 'ranked') return null;
  const { authIndex, drain } = routing.entry;
  const change = async (next: boolean) => {
    setBusy(true);
    try {
      await onChange(authIndex, next);
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className={styles.routingDrain}>
      <input
        type="checkbox"
        checked={drain}
        disabled={busy}
        onChange={(event) => void change(event.target.checked)}
      />
      {t('quota_routing.drain')}
    </label>
  );
}

/** The account's pace, or why the selector holds it back; then its model cooldowns. */
export function RoutingNotes({ routing, file }: { routing: CardRouting; file: AuthFileItem }) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  return (
    <div className={routingStyles.routingLines}>
      {routingNotes(t, routing, file, now, i18n.language).map((note) => (
        <p
          key={note.text}
          className={`${routingStyles.routingLine} ${note.warn ? routingStyles.routingLineWarn : ''}`}
          title={note.title}
        >
          {note.text}
        </p>
      ))}
    </div>
  );
}

/** Sets a pool's speed (0 to 1), or returns it to the computed throttle with null. */
export type ThrottleOverrideChange = (provider: string, speed: number | null) => Promise<void>;

/**
 * Pool runway per provider the tab shows, and whether the throttle slows requests now. With
 * `onOverride`, each pool whose throttle is on gets a switch that fixes its speed.
 */
export function PoolRunwayLines({
  pools,
  tab,
  className,
  onOverride,
}: {
  pools: readonly PoolRanking[];
  tab: QuotaTabId;
  className?: string;
  onOverride?: ThrottleOverrideChange;
}) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const lines = poolRunwayLines(t, pools, tab, now, i18n.language);
  if (lines.length === 0) return null;
  return (
    <div className={className}>
      {lines.map((line) => (
        <div key={line.provider} className={routingStyles.runwayRow}>
          <p
            className={`${routingStyles.routingLine} ${line.warn ? routingStyles.routingLineWarn : ''}`}
            title={line.title}
          >
            {line.text}
          </p>
          {onOverride && line.overridable && (
            <ThrottleOverrideControl
              provider={line.provider}
              providerLabel={line.providerLabel}
              override={line.override}
              onChange={onOverride}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** Full speed: the reason to override is usually quota the plan does not count. */
const DEFAULT_OVERRIDE_PERCENT = 100;

function ThrottleOverrideControl({
  provider,
  providerLabel,
  override,
  onChange,
}: {
  provider: string;
  providerLabel: string;
  override: number | null;
  onChange: ThrottleOverrideChange;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  // The switch stays enabled while a change is pending, so it keeps keyboard focus; the ref
  // drops a second change until the first one settles.
  const pending = useRef(false);
  const change = async (speed: number | null) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await onChange(provider, speed);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const percent = override === null ? null : Math.round(override * 100);
  return (
    <div className={routingStyles.throttleOverride}>
      {percent !== null && (
        // Keyed by the server's value, so the field follows it after every change. It sits
        // before the switch, so the switches of all pools stay in one column.
        <OverrideSpeedForm
          key={percent}
          providerLabel={providerLabel}
          percent={percent}
          busy={busy}
          onApply={(next) => void change(next / 100)}
        />
      )}
      <ToggleSwitch
        checked={override !== null}
        onChange={(on) => void change(on ? DEFAULT_OVERRIDE_PERCENT / 100 : null)}
        label={t('quota_routing.override_toggle')}
        ariaLabel={t('quota_routing.override_toggle_aria', { provider: providerLabel })}
      />
    </div>
  );
}

function OverrideSpeedForm({
  providerLabel,
  percent,
  busy,
  onApply,
}: {
  providerLabel: string;
  percent: number;
  busy: boolean;
  onApply: (percent: number) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(String(percent));
  const next = Number(draft);
  const valid = draft.trim() !== '' && Number.isInteger(next) && next >= 0 && next <= 100;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && next !== percent) onApply(next);
  };
  return (
    <form className={routingStyles.overrideForm} onSubmit={submit}>
      <input
        className={`input ${routingStyles.overrideInput}`}
        type="number"
        min={0}
        max={100}
        step={1}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        aria-label={t('quota_routing.override_speed_label', { provider: providerLabel })}
        aria-invalid={!valid}
      />
      <span aria-hidden="true">%</span>
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        className={routingStyles.overrideApply}
        disabled={busy || !valid || next === percent}
      >
        {t('quota_routing.override_apply')}
      </Button>
    </form>
  );
}

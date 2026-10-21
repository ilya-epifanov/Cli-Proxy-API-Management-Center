/**
 * Routing on a Quota card: where the pace selector ranks the account for new sessions and why.
 * The rank chip sits in the card header; the routing notes sit under it.
 */

import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import type { PoolRanking } from '@/services/api';
import type { AuthFileItem } from '@/types';
import type { QuotaTabId } from '../constants';
import { poolRunwayLines, routingNotes, routingRankTitle, type CardRouting } from '../routing';
import styles from './QuotaCard.module.scss';

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

/** The account's pace, or why the selector holds it back; then its model cooldowns. */
export function RoutingNotes({ routing, file }: { routing: CardRouting; file: AuthFileItem }) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  return (
    <div className={styles.routingLines}>
      {routingNotes(t, routing, file, now, i18n.language).map((note) => (
        <p
          key={note.text}
          className={`${styles.routingLine} ${note.warn ? styles.routingLineWarn : ''}`}
          title={note.title}
        >
          {note.text}
        </p>
      ))}
    </div>
  );
}

/** Pool runway per provider the tab shows, and whether the throttle slows requests now. */
export function PoolRunwayLines({
  pools,
  tab,
  className,
}: {
  pools: readonly PoolRanking[];
  tab: QuotaTabId;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const lines = poolRunwayLines(t, pools, tab, now, i18n.language);
  if (lines.length === 0) return null;
  return (
    <div className={className}>
      {lines.map((line) => (
        <p
          key={line.provider}
          className={`${styles.routingLine} ${line.warn ? styles.routingLineWarn : ''}`}
          title={line.title}
        >
          {line.text}
        </p>
      ))}
    </div>
  );
}

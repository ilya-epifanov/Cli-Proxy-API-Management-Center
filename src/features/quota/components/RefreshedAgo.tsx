import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { MINUTE_MS } from '@/utils/time/durations';
import { SECOND_CLOCK } from '@/utils/time/sharedClock';
import { refreshedAgo } from '../refreshedAgo';
import styles from './QuotaCard.module.scss';

/** "45s ago", "12m ago" or "1:05 ago" since the server read the quota, kept current. */
export function RefreshedAgo({ at }: { at: number }) {
  const { t, i18n } = useTranslation();
  const minuteNow = useNow();
  // Count seconds while the read is under a minute old; the minute clock can lag by up to a
  // minute, which only means some extra second ticks.
  const countingSeconds = minuteNow - at < MINUTE_MS;
  const secondNow = useNow(countingSeconds, SECOND_CLOCK);
  const now = countingSeconds ? secondNow : minuteNow;
  const { unit, value } = refreshedAgo(now - at);
  const time = new Date(at).toLocaleString(i18n.language);
  return (
    <span className={styles.refreshedAgo} title={t('quota_management.refreshed_title', { time })}>
      <time dateTime={new Date(at).toISOString()}>
        {t(`quota_management.refreshed_${unit}`, { value })}
      </time>
    </span>
  );
}

/**
 * Usage history (docs/frontend-design.md §8.5): tokens or requests over time, stacked by
 * provider, account or model, and a provider ▸ account ▸ model breakdown of the same window.
 */

import { Fragment, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconAlertTriangle, IconInfo } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import {
  USAGE_GROUP_BYS,
  type UsageCounters,
  type UsageGroupBy,
} from '@/services/api/usageHistory';
import { useAuthStore } from '@/stores';
import { formatCompactNumber } from '@/utils/format';
import { SegmentedControl } from './SegmentedControl';
import { UsageChart } from './UsageChart';
import { UsageTable, type UsageRowLabel } from './UsageTable';
import {
  accountProviders,
  assignSeriesSlots,
  buildUsageStack,
  buildUsageTree,
  groupLabel,
  rangeBucket,
  outputTokens,
  rankGroups,
  STACK_LIMIT,
  sumCounters,
  totalTokens,
  USAGE_METRICS,
  USAGE_RANGES,
  type SeriesSlot,
  type StackLayer,
  type UsageMetric,
  type UsageRange,
  type UsageStack,
  type UsageTreeNode,
} from './usageModel';
import { useUsageHistory, type UsageSnapshot } from './useUsageHistory';
import styles from './UsagePage.module.scss';

/** The fork's config key that turns the usage store on. */
export const USAGE_STORE_CONFIG_KEY = 'observability.usage.store.enable';

interface SlotState {
  signature: string;
  groupBy: UsageGroupBy | null;
  slots: ReadonlyMap<string, SeriesSlot>;
}

/**
 * Colour slots that survive refreshes and range changes (assignSeriesSlots). Updated while
 * rendering, React's pattern for state derived from changing inputs, so no frame shows the
 * previous assignment.
 */
function useSeriesSlots(groupBy: UsageGroupBy | null, members: readonly string[]) {
  const signature = `${groupBy ?? ''}\u0000${members.join('\u0000')}`;
  const [state, setState] = useState<SlotState>(() => ({
    signature,
    groupBy,
    slots: assignSeriesSlots(new Map(), members),
  }));
  if (state.signature === signature) return state.slots;
  const slots = assignSeriesSlots(state.groupBy === groupBy ? state.slots : new Map(), members);
  setState({ signature, groupBy, slots });
  return slots;
}

function UsageSkeleton() {
  return (
    <div className={styles.sections} aria-hidden="true">
      <Skeleton height={340} rounded={16} />
      <Skeleton height={260} rounded={16} />
    </div>
  );
}

/** Chart layers, breakdown tree, totals and display labels for one loaded window. */
function useUsageView(snapshot: UsageSnapshot | null, metric: UsageMetric) {
  const { t } = useTranslation();

  const ranking = useMemo(
    () => (snapshot ? rankGroups(snapshot.series, metric) : { members: [], folded: [] }),
    [snapshot, metric]
  );
  const slots = useSeriesSlots(snapshot?.query.groupBy ?? null, ranking.members);
  const stack = useMemo(
    () =>
      snapshot
        ? buildUsageStack(snapshot.series, slots, ranking.folded, metric, snapshot.starts.length)
        : null,
    [snapshot, slots, ranking.folded, metric]
  );
  const tree = useMemo(() => (snapshot ? buildUsageTree(snapshot.rows) : []), [snapshot]);
  const totals = useMemo(() => sumCounters(snapshot?.rows ?? []), [snapshot]);

  const labelContext = useMemo(
    () => ({
      names: snapshot?.names ?? new Map<string, string>(),
      providers: accountProviders(snapshot?.rows ?? []),
      unknownLabel: t('usage.unknown'),
    }),
    [snapshot, t]
  );

  const layerLabel = useCallback(
    (layer: StackLayer) =>
      layer.kind === 'other'
        ? t('usage.chart_other')
        : groupLabel(snapshot?.query.groupBy ?? 'provider', layer.key, labelContext),
    [labelContext, snapshot, t]
  );

  const rowLabel = useCallback(
    (node: UsageTreeNode): UsageRowLabel => {
      // Under a provider row, an account needs no provider suffix and a model is its own name.
      const context = { ...labelContext, providers: new Map<string, string>() };
      if (node.level === 'provider') {
        return { primary: groupLabel('provider', node.key, context), secondary: null };
      }
      if (node.level === 'model') {
        return { primary: groupLabel('model', node.key, context), secondary: null };
      }
      const primary = groupLabel('auth_index', node.key, context);
      return { primary, secondary: node.key && primary !== node.key ? node.key : null };
    },
    [labelContext]
  );

  return { ranking, stack, tree, totals, layerLabel, rowLabel };
}

/** Range name and totals under the title. */
function UsageSummary({
  range,
  totals,
  metric,
}: {
  range: UsageRange;
  totals: UsageCounters;
  metric: UsageMetric;
}) {
  const { t, i18n } = useTranslation();
  const exact = (value: number) => value.toLocaleString(i18n.language);
  // The output view counts output tokens here too, so the summary matches the chart.
  const output = metric === 'output';
  const tokens = output ? outputTokens(totals) : totalTokens(totals);
  const parts = [
    <span key="range">{t(`usage.range_name_${range}`)}</span>,
    <span key="tokens" title={exact(tokens)}>
      {t(output ? 'usage.meta_output' : 'usage.meta_tokens', {
        value: formatCompactNumber(tokens),
      })}
    </span>,
    <span key="requests">{t('usage.meta_requests', { value: exact(totals.requests) })}</span>,
  ];
  if (totals.failed > 0) {
    parts.push(<span key="failed">{t('usage.meta_failed', { value: exact(totals.failed) })}</span>);
  }
  return (
    <p className={styles.meta}>
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index > 0 && (
            <span className={styles.metaDot} aria-hidden="true">
              ·
            </span>
          )}
          {part}
        </Fragment>
      ))}
    </p>
  );
}

interface UsageSectionsProps {
  snapshot: UsageSnapshot;
  metric: UsageMetric;
  stack: UsageStack | null;
  foldedCount: number;
  tree: UsageTreeNode[];
  layerLabel: (layer: StackLayer) => string;
  rowLabel: (node: UsageTreeNode) => UsageRowLabel;
}

/** The chart and the breakdown table of one loaded window, or the empty state. */
function UsageSections({
  snapshot,
  metric,
  stack,
  foldedCount,
  tree,
  layerLabel,
  rowLabel,
}: UsageSectionsProps) {
  const { t } = useTranslation();
  if (snapshot.rows.length === 0 && snapshot.series.length === 0) {
    return <EmptyState title={t('usage.empty_title')} description={t('usage.empty_desc')} />;
  }
  const bucket = rangeBucket(snapshot.query.range);
  const chartTitle = t(`usage.chart_title_${metric}_${bucket}`);
  const stackedBy = t(`usage.chart_stacked_${snapshot.query.groupBy}`);
  return (
    <div className={styles.sections}>
      <section className={styles.panel} aria-labelledby="usage-chart-title">
        <header className={styles.panelHead}>
          <h2 id="usage-chart-title" className={styles.panelTitle}>
            {chartTitle}
          </h2>
          <p className={styles.panelDescription}>
            {stackedBy}
            {foldedCount > 0 &&
              ` · ${t('usage.chart_folded', { count: STACK_LIMIT, folded: foldedCount })}`}
          </p>
        </header>
        {stack && (
          <UsageChart
            stack={stack}
            starts={snapshot.starts}
            range={snapshot.query.range}
            timeZone={snapshot.timeZone}
            labelOf={layerLabel}
            title={chartTitle}
            emptyLabel={t(`usage.chart_empty_${metric}`)}
          />
        )}
      </section>

      <section className={styles.panel} aria-labelledby="usage-table-title">
        <header className={styles.panelHead}>
          <h2 id="usage-table-title" className={styles.panelTitle}>
            {t('usage.table_title')}
          </h2>
          <p className={styles.panelDescription}>{t('usage.table_description')}</p>
          <p className={styles.panelNote}>{t('usage.table_tokens_note')}</p>
        </header>
        <UsageTable tree={tree} labelOf={rowLabel} />
      </section>
    </div>
  );
}

export function UsagePage() {
  const { t, i18n } = useTranslation();
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [range, setRange] = useState<UsageRange>('24h');
  const [groupBy, setGroupBy] = useState<UsageGroupBy>('provider');
  const [metric, setMetric] = useState<UsageMetric>('tokens');

  const query = useMemo(() => ({ range, groupBy }), [range, groupBy]);
  const { data, loading, error, reload } = useUsageHistory(query);
  useHeaderRefresh(reload, connected);

  const snapshot: UsageSnapshot | null = data.tag === 'enabled' ? data.snapshot : null;

  const { ranking, stack, tree, totals, layerLabel, rowLabel } = useUsageView(snapshot, metric);

  /* ---------- controls ---------- */

  const rangeOptions = USAGE_RANGES.map((value) => ({ value, label: t(`usage.range_${value}`) }));
  const groupOptions = USAGE_GROUP_BYS.map((value) => ({
    value,
    label: t(`usage.group_${value}`),
  }));
  const metricOptions = USAGE_METRICS.map((value) => ({
    value,
    label: t(`usage.metric_${value}`),
  }));
  const showControls = data.tag === 'checking' || data.tag === 'enabled';

  /* ---------- render ---------- */

  const exact = (value: number) => value.toLocaleString(i18n.language);
  const shownRange = snapshot?.query.range ?? range;
  // The controls changed and the matching data is still loading: dim what is on screen.
  const stale =
    loading &&
    snapshot !== null &&
    (snapshot.query.range !== range || snapshot.query.groupBy !== groupBy);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>{t('usage.title')}</h1>
        {snapshot && <UsageSummary range={shownRange} totals={totals} metric={metric} />}
      </header>

      {showControls && (
        <div className={styles.toolbar}>
          <SegmentedControl
            label={t('usage.range_label')}
            options={rangeOptions}
            value={range}
            disabled={!connected}
            onChange={setRange}
          />
          <SegmentedControl
            label={t('usage.group_label')}
            options={groupOptions}
            value={groupBy}
            disabled={!connected}
            onChange={setGroupBy}
          />
          <SegmentedControl
            label={t('usage.metric_label')}
            options={metricOptions}
            value={metric}
            onChange={setMetric}
          />
        </div>
      )}

      {error && (
        <div className={styles.errorBanner} role="alert">
          {error}
        </div>
      )}

      {snapshot && snapshot.droppedRecords > 0 && (
        <p className={`${styles.notice} ${styles.noticeWarning}`} role="status">
          <IconAlertTriangle size={16} className={styles.noticeIcon} />
          {t('usage.dropped_notice', { count: exact(snapshot.droppedRecords) })}
        </p>
      )}
      {snapshot?.namesError && (
        <p className={styles.notice} role="status">
          <IconInfo size={16} className={styles.noticeIcon} />
          {t('usage.names_unavailable', { message: snapshot.namesError })}
        </p>
      )}

      {data.tag === 'checking' && loading && <UsageSkeleton />}
      {data.tag === 'upstream' && (
        <EmptyState title={t('usage.upstream_title')} description={t('usage.upstream_desc')} />
      )}
      {data.tag === 'disabled' && (
        <EmptyState
          title={t('usage.disabled_title')}
          description={t('usage.disabled_desc', { key: USAGE_STORE_CONFIG_KEY })}
        />
      )}
      {snapshot && (
        <div className={stale ? styles.stale : undefined} aria-busy={stale}>
          <UsageSections
            snapshot={snapshot}
            metric={metric}
            stack={stack}
            foldedCount={ranking.folded.length}
            tree={tree}
            layerLabel={layerLabel}
            rowLabel={rowLabel}
          />
        </div>
      )}
    </div>
  );
}

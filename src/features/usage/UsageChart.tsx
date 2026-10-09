import { useId, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Collapsible } from '@/components/ui/Collapsible';
import { axisMax } from '@/features/dashboard/utils';
import { formatCompactNumber } from '@/utils/format';
import {
  axisTickIndices,
  rangeBucket,
  type StackLayer,
  type UsageRange,
  type UsageStack,
} from './usageModel';
import styles from './UsageChart.module.scss';

/** Y-axis lines including 0. */
const TICK_COUNT = 5;
const HOUR_MS = 3_600_000;
/** Past this many columns the gap between them shrinks to 1px, so the bars keep some width. */
const DENSE_COLUMNS = 72;
/** The whole entrance wave finishes within this, however many columns there are. */
const ENTRANCE_BUDGET_MS = 360;

const SLOT_CLASSES = [
  styles.slot1,
  styles.slot2,
  styles.slot3,
  styles.slot4,
  styles.slot5,
  styles.slot6,
] as const;

const slotClass = (layer: StackLayer): string =>
  layer.kind === 'group' ? SLOT_CLASSES[layer.slot] : styles.slotOther;

const layerId = (layer: StackLayer): string =>
  layer.kind === 'group' ? `group:${layer.key}` : 'other';

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(' ');

function useBucketFormat(locale: string, range: UsageRange, timeZone: string) {
  return useMemo(() => {
    const tick = new Intl.DateTimeFormat(
      locale,
      range === '24h'
        ? { timeZone, hour: '2-digit', minute: '2-digit' }
        : range === '7d'
          ? { timeZone, weekday: 'short', day: 'numeric' }
          : { timeZone, month: 'short', day: 'numeric' }
    );
    const day = new Intl.DateTimeFormat(locale, {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const time = new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit' });
    const hourly = rangeBucket(range) === '1h';
    return {
      tick: (start: number) => tick.format(start),
      bucket: (start: number) =>
        hourly
          ? `${day.format(start)}, ${time.format(start)}–${time.format(start + HOUR_MS)}`
          : day.format(start),
    };
  }, [locale, range, timeZone]);
}

interface LayerListProps {
  layers: readonly StackLayer[];
  labelOf: (layer: StackLayer) => string;
}

function useExactFormat() {
  const { i18n } = useTranslation();
  return (value: number) => value.toLocaleString(i18n.language);
}

function ChartLegend({ layers, labelOf }: LayerListProps) {
  const exact = useExactFormat();
  return (
    <figcaption className={styles.legend}>
      {layers.map((layer) => (
        <span key={layerId(layer)} className={styles.legendItem}>
          <span className={cx(styles.swatch, slotClass(layer))} aria-hidden="true" />
          <span className={styles.legendLabel}>{labelOf(layer)}</span>
          <b className={styles.legendValue} title={exact(layer.total)}>
            {formatCompactNumber(layer.total)}
          </b>
        </span>
      ))}
    </figcaption>
  );
}

interface ChartTooltipProps extends LayerListProps {
  /** Selected column. */
  index: number;
  count: number;
  time: string;
  total: number;
}

/**
 * Values of the selected column, top layer first, kept inside the plot near its edges. Visual
 * only: keyboard selection is announced through the chart's live region.
 */
function ChartTooltip({ layers, labelOf, index, count, time, total }: ChartTooltipProps) {
  const { t } = useTranslation();
  const exact = useExactFormat();
  const shift = index < count * 0.2 ? '-8%' : index > count * 0.8 ? '-92%' : '-50%';
  return (
    <div
      className={styles.tooltip}
      style={{ left: `${((index + 0.5) / count) * 100}%`, transform: `translateX(${shift})` }}
      aria-hidden="true"
    >
      <span className={styles.tooltipTime}>{time}</span>
      {[...layers].reverse().map((layer) => (
        <span key={layerId(layer)} className={styles.tooltipRow}>
          <span className={cx(styles.tooltipKey, slotClass(layer))} aria-hidden="true" />
          <b>{exact(layer.values[index])}</b>
          <span className={styles.tooltipLabel}>{labelOf(layer)}</span>
        </span>
      ))}
      <span className={styles.tooltipTotal}>
        <b>{exact(total)}</b>
        <span>{t('usage.chart_total')}</span>
      </span>
    </div>
  );
}

interface ChartDataTableProps extends LayerListProps {
  starts: readonly number[];
  columnTotals: readonly number[];
  bucketLabel: (start: number) => string;
}

/** Every plotted value, for readers who cannot use the columns. */
function ChartDataTable({
  layers,
  labelOf,
  starts,
  columnTotals,
  bucketLabel,
}: ChartDataTableProps) {
  const { t } = useTranslation();
  const exact = useExactFormat();
  return (
    <Collapsible className={styles.tableToggle} label={t('usage.chart_table')}>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('usage.chart_table_time')}</th>
              {layers.map((layer) => (
                <th key={layerId(layer)} scope="col">
                  {labelOf(layer)}
                </th>
              ))}
              <th scope="col">{t('usage.chart_total')}</th>
            </tr>
          </thead>
          <tbody>
            {starts.map((start, index) => (
              <tr key={start}>
                <th scope="row">{bucketLabel(start)}</th>
                {layers.map((layer) => (
                  <td key={layerId(layer)}>{exact(layer.values[index])}</td>
                ))}
                <td>{exact(columnTotals[index])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Collapsible>
  );
}

interface UsageChartProps {
  stack: UsageStack;
  /** Bucket starts, one per column. */
  starts: readonly number[];
  range: UsageRange;
  timeZone: string;
  labelOf: (layer: StackLayer) => string;
  /** Names the plotted metric and bucket, for the accessible summary. */
  title: string;
  emptyLabel: string;
}

/**
 * Stacked columns over time: one layer per group in colour-slot order, "other" on top.
 * Hover, click or arrow keys pick a column; the data table carries every value without either.
 */
export function UsageChart({
  stack,
  starts,
  range,
  timeZone,
  labelOf,
  title,
  emptyLabel,
}: UsageChartProps) {
  const { t, i18n } = useTranslation();
  const hintId = useId();
  const [selected, setSelected] = useState<number | null>(null);
  // Pointer hover crosses many columns; only keyboard selection is announced.
  const [selectedByKeyboard, setSelectedByKeyboard] = useState(false);
  const format = useBucketFormat(i18n.language, range, timeZone);
  const exact = useExactFormat();

  const count = starts.length;
  const active = selected !== null && selected < count ? selected : null;
  const { layers, columnTotals, peak } = stack;

  const scaleMax = axisMax(peak?.value ?? 0, TICK_COUNT - 1);
  const yTicks = Array.from({ length: TICK_COUNT }, (_, index) => {
    const ratio = 1 - index / (TICK_COUNT - 1);
    return { ratio, value: scaleMax * ratio };
  });
  const xTicks = useMemo(() => axisTickIndices(range, starts, timeZone), [range, starts, timeZone]);
  const percentOf = (value: number) => Math.min(100, (value / scaleMax) * 100);

  const summary = peak
    ? `${title}. ${t('usage.chart_summary', {
        total: exact(stack.total),
        peak: exact(peak.value),
        time: format.bucket(starts[peak.index]),
      })}`
    : `${title}. ${emptyLabel}`;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return;
    const current = active ?? count - 1;
    const next: Record<string, number | null> = {
      ArrowLeft: Math.max(0, current - 1),
      ArrowRight: Math.min(count - 1, current + 1),
      Home: 0,
      End: count - 1,
      Escape: null,
    };
    if (!(event.key in next)) return;
    event.preventDefault();
    setSelected(next[event.key]);
    setSelectedByKeyboard(true);
  };

  return (
    <figure className={styles.chart}>
      {layers.length > 0 && <ChartLegend layers={layers} labelOf={labelOf} />}

      <div className={styles.plot}>
        <div className={styles.yAxis} aria-hidden="true">
          {yTicks.map((tick) => (
            <span
              key={tick.ratio}
              className={styles.yTick}
              style={{ top: `${(1 - tick.ratio) * 100}%` }}
            >
              {formatCompactNumber(tick.value)}
            </span>
          ))}
        </div>

        <div className={styles.canvas}>
          <div className={styles.gridlines} aria-hidden="true">
            {yTicks.map((tick) => (
              <span
                key={tick.ratio}
                className={styles.gridline}
                style={{ top: `${(1 - tick.ratio) * 100}%` }}
              />
            ))}
          </div>

          <div
            className={styles.columns}
            style={{ '--column-gap': count > DENSE_COLUMNS ? '1px' : '2px' } as CSSProperties}
            role="group"
            aria-label={summary}
            aria-describedby={hintId}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onFocus={() => {
              setSelectedByKeyboard(true);
              setSelected((current) => current ?? (count > 0 ? count - 1 : null));
            }}
            onBlur={() => setSelected(null)}
            onMouseLeave={() => setSelected(null)}
          >
            {starts.map((start, index) => {
              const visible = layers.filter((layer) => layer.values[index] > 0);
              const delayMs =
                count > 1 ? Math.round((index / (count - 1)) * ENTRANCE_BUDGET_MS) : 0;
              return (
                <div
                  key={start}
                  className={cx(styles.column, active === index && styles.columnActive)}
                  onMouseEnter={() => {
                    setSelected(index);
                    setSelectedByKeyboard(false);
                  }}
                  onClick={() => {
                    setSelected(index);
                    setSelectedByKeyboard(false);
                  }}
                >
                  {peak?.index === index && (
                    <span
                      className={styles.peakLabel}
                      style={{ bottom: `${percentOf(peak.value)}%` }}
                    >
                      {formatCompactNumber(peak.value)}
                    </span>
                  )}
                  <div
                    className={styles.stack}
                    style={{ '--bar-delay': `${delayMs}ms` } as CSSProperties}
                  >
                    {visible.map((layer, position) => (
                      <span
                        key={layerId(layer)}
                        className={cx(
                          styles.segment,
                          slotClass(layer),
                          position > 0 && styles.segmentStacked,
                          position === visible.length - 1 && styles.segmentTop
                        )}
                        style={{ height: `${percentOf(layer.values[index])}%` }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <p id={hintId} className={styles.visuallyHidden}>
            {t('usage.chart_keyboard_hint')}
          </p>
          <p className={styles.visuallyHidden} aria-live="polite">
            {active !== null && selectedByKeyboard
              ? [
                  format.bucket(starts[active]),
                  ...[...layers]
                    .reverse()
                    .map((layer) => `${labelOf(layer)} ${exact(layer.values[active])}`),
                  `${t('usage.chart_total')} ${exact(columnTotals[active])}`,
                ].join(', ')
              : ''}
          </p>

          {stack.total === 0 && <p className={styles.empty}>{emptyLabel}</p>}

          {active !== null && (
            <ChartTooltip
              layers={layers}
              labelOf={labelOf}
              index={active}
              count={count}
              time={format.bucket(starts[active])}
              total={columnTotals[active]}
            />
          )}
        </div>
      </div>

      <div className={styles.xAxis} aria-hidden="true">
        {xTicks.map((index) => (
          <span
            key={starts[index]}
            className={styles.xTick}
            style={{ left: `${((index + 0.5) / count) * 100}%` }}
          >
            {format.tick(starts[index])}
          </span>
        ))}
      </div>

      {layers.length > 0 && (
        <ChartDataTable
          layers={layers}
          labelOf={labelOf}
          starts={starts}
          columnTotals={columnTotals}
          bucketLabel={format.bucket}
        />
      )}
    </figure>
  );
}

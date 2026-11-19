import { useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown } from '@/components/ui/icons';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import type { UsageCounters } from '@/services/api/usageHistory';
import { formatCompactNumber } from '@/utils/format';
import { sumCounters, totalTokens, type UsageTreeNode } from './usageModel';
import { useExactFormat } from './useExactFormat';
import styles from './UsageTable.module.scss';

interface Column {
  id: string;
  value: (counters: UsageCounters) => number;
}

/** Disjoint token buckets, then their sum: no column is counted twice. */
const COLUMNS: readonly Column[] = [
  { id: 'requests', value: (c) => c.requests },
  { id: 'failed', value: (c) => c.failed },
  { id: 'input', value: (c) => c.input },
  { id: 'cache_read', value: (c) => c.cacheRead },
  { id: 'cache_write', value: (c) => c.cacheWrite },
  { id: 'output', value: (c) => c.output },
  { id: 'reasoning', value: (c) => c.reasoning },
  { id: 'unclassified', value: (c) => c.unclassified },
  { id: 'total', value: totalTokens },
];

/** Exact below this; compact above, with the exact value in the title. */
const EXACT_LIMIT = 100_000;

export interface UsageRowLabel {
  primary: string;
  /** Identifier shown under the name, such as the raw auth_index. */
  secondary: string | null;
}

interface UsageTableProps {
  tree: readonly UsageTreeNode[];
  labelOf: (node: UsageTreeNode) => UsageRowLabel;
}

interface VisibleRow {
  node: UsageTreeNode;
  depth: number;
  expanded: boolean;
}

/** Providers start expanded and accounts collapsed; `toggled` holds the rows flipped from that. */
const isExpanded = (node: UsageTreeNode, toggled: ReadonlySet<string>) =>
  node.level === 'provider' ? !toggled.has(node.id) : toggled.has(node.id);

const visibleRows = (
  nodes: readonly UsageTreeNode[],
  toggled: ReadonlySet<string>,
  depth = 0
): VisibleRow[] =>
  nodes.flatMap((node) => {
    const expanded = node.children.length > 0 && isExpanded(node, toggled);
    const row = { node, depth, expanded };
    return expanded ? [row, ...visibleRows(node.children, toggled, depth + 1)] : [row];
  });

/** Provider ▸ account ▸ model, each level sorted by total tokens. */
export function UsageTable({ tree, labelOf }: UsageTableProps) {
  const { t } = useTranslation();
  const exact = useExactFormat();
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());

  const grandTotal = useMemo(() => sumCounters(tree.map((node) => node.counters)), [tree]);
  // Unclassified tokens are rare; show the column only when some exist, so the visible token
  // columns always add up to the total.
  const columns = useMemo(
    () => COLUMNS.filter((column) => column.id !== 'unclassified' || grandTotal.unclassified > 0),
    [grandTotal]
  );
  const rows = useMemo(() => visibleRows(tree, toggled), [tree, toggled]);

  const toggle = (id: string) =>
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderValue = (value: number) => {
    const text = exact(value);
    const compact = value >= EXACT_LIMIT;
    return (
      <span className={value === 0 ? styles.zero : undefined} title={compact ? text : undefined}>
        {compact ? formatCompactNumber(value) : text}
      </span>
    );
  };

  return (
    <Table className={styles.table}>
      <TableHeader>
        <TableRow>
          <TableHead scope="col" className={styles.nameHead}>
            {t('usage.column_name')}
          </TableHead>
          {columns.map((column) => (
            <TableHead key={column.id} scope="col" alignRight title={t(`usage.hint_${column.id}`)}>
              <span className={styles.headLabel}>{t(`usage.column_${column.id}`)}</span>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ node, depth, expanded }) => {
          const label = labelOf(node);
          return (
            <TableRow key={node.id} className={styles[node.level]}>
              <TableCell
                role="rowheader"
                className={styles.nameCell}
                style={{ '--depth': depth } as CSSProperties}
              >
                <div className={styles.name}>
                  {node.children.length > 0 ? (
                    <button
                      type="button"
                      className={styles.disclosure}
                      aria-expanded={expanded}
                      onClick={() => toggle(node.id)}
                    >
                      <IconChevronDown
                        size={14}
                        className={expanded ? styles.chevronOpen : styles.chevron}
                      />
                      <span className={styles.primary}>{label.primary}</span>
                    </button>
                  ) : (
                    <span className={styles.leaf}>
                      <span className={styles.primary}>{label.primary}</span>
                    </span>
                  )}
                  {label.secondary && <span className={styles.secondary}>{label.secondary}</span>}
                </div>
              </TableCell>
              {columns.map((column) => (
                <TableCell key={column.id} alignRight className={styles.number}>
                  {renderValue(column.value(node.counters))}
                </TableCell>
              ))}
            </TableRow>
          );
        })}
      </TableBody>
      <tfoot className={styles.foot}>
        <tr>
          <th scope="row" className={styles.nameCell}>
            {t('usage.row_total')}
          </th>
          {columns.map((column) => (
            <td key={column.id} className={styles.number}>
              {renderValue(column.value(grandTotal))}
            </td>
          ))}
        </tr>
      </tfoot>
    </Table>
  );
}

import { useId } from 'react';
import styles from './SegmentedControl.module.scss';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  /** The visible label, or the accessible name when `hideLabel` is set. */
  label: string;
  hideLabel?: boolean;
  options: readonly SegmentedOption<T>[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}

/** Single-choice toggle group, with a visible label unless `hideLabel` is set. */
export function SegmentedControl<T extends string>({
  label,
  hideLabel = false,
  options,
  value,
  disabled = false,
  onChange,
}: SegmentedControlProps<T>) {
  const labelId = useId();
  const group = (
    <div
      className={styles.segmented}
      role="group"
      aria-label={hideLabel ? label : undefined}
      aria-labelledby={hideLabel ? undefined : labelId}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`${styles.segment} ${option.value === value ? styles.segmentActive : ''}`}
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
  if (hideLabel) return group;
  return (
    <div className={styles.field}>
      <span id={labelId} className={styles.label}>
        {label}
      </span>
      {group}
    </div>
  );
}

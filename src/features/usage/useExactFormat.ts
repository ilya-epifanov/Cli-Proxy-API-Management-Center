import { useTranslation } from 'react-i18next';

/** Formats a count in full, with the grouping of the UI language. */
export function useExactFormat() {
  const { i18n } = useTranslation();
  return (value: number) => value.toLocaleString(i18n.language);
}

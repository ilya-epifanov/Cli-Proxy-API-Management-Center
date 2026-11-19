import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { formatSignedInAgo } from '@/features/authFiles/signedInAgo';

/**
 * "Signed in N days ago" label. Kept as its own component so the minute clock
 * re-renders only this span, not the whole auth file card.
 */
export function SignedInAgo({ signedInAt }: { signedInAt: number }) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  return (
    <span title={new Date(signedInAt).toLocaleString(i18n.language)}>
      {t('auth_files.signed_in', { when: formatSignedInAgo(signedInAt, now, i18n.language) })}
    </span>
  );
}

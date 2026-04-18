/**
 * PrivacyTierBadge — Stage 5
 *
 * Inline badge showing a claim or media item's privacy tier.
 * Used on ProfileCard, FamilyTreeView, and media items.
 */

import { useTranslation } from 'react-i18next'
import { Badge } from 'react-bootstrap'
import type { PrivacyTier } from '../types/chronicle'

interface Props {
  tier: PrivacyTier
  /** Show as a small badge (default true) */
  small?: boolean
}

const TIER_CONFIG: Record<PrivacyTier, { bg: string; icon: string }> = {
  public:  { bg: 'success',   icon: '🌐' },
  family:  { bg: 'primary',   icon: '👨‍👩‍👧' },
  private: { bg: 'secondary', icon: '🔒' },
}

export function PrivacyTierBadge({ tier, small = true }: Props) {
  const { t } = useTranslation()
  const { bg, icon } = TIER_CONFIG[tier]

  return (
    <Badge
      bg={bg}
      className={small ? 'ms-1' : 'ms-2 fs-6'}
      title={t(`privacy.tierDescriptions.${tier}`)}
    >
      {icon} {t(`privacy.tiers.${tier}`)}
    </Badge>
  )
}

/**
 * PrivacyTierSelector — dropdown for choosing a tier when adding a claim or uploading media.
 */
interface SelectorProps {
  value: PrivacyTier
  onChange: (tier: PrivacyTier) => void
  disabled?: boolean
  className?: string
}

export function PrivacyTierSelector({ value, onChange, disabled, className }: SelectorProps) {
  const { t } = useTranslation()
  const tiers: PrivacyTier[] = ['public', 'family', 'private']

  return (
    <select
      className={`form-select form-select-sm ${className ?? ''}`}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as PrivacyTier)}
      aria-label={t('privacy.title')}
    >
      {tiers.map((tier) => (
        <option key={tier} value={tier}>
          {TIER_CONFIG[tier].icon} {t(`privacy.tiers.${tier}`)} — {t(`privacy.tierDescriptions.${tier}`)}
        </option>
      ))}
    </select>
  )
}

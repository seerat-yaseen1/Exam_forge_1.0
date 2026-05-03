import { useAuth } from '../context/AuthContext';

interface PlatformLogoProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  /** Override the logo shown (used on login screen before auth context loads) */
  staticLogoUrl?: string | null;
  staticName?: string;
}

export function LogoMark({ px, color = 'currentColor' }: { px: number; color?: string }) {
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* Four-quadrant mark: hierarchy of weight signals layered authority */}
      <rect x="1" y="1" width="10" height="10" fill={color} />
      <rect x="13" y="1" width="10" height="10" fill={color} fillOpacity="0.38" />
      <rect x="1" y="13" width="10" height="10" fill={color} fillOpacity="0.18" />
      <rect x="13" y="13" width="10" height="10" fill={color} fillOpacity="0.65" />
    </svg>
  );
}

const sizeMap = {
  sm: { px: 16, nameClass: 'text-sm' },
  md: { px: 20, nameClass: 'text-sm' },
  lg: { px: 26, nameClass: 'text-base' },
};

export function PlatformLogo({
  size = 'md',
  className = '',
  staticLogoUrl,
  staticName,
}: PlatformLogoProps) {
  const { platformSettings } = useAuth();
  const { px, nameClass } = sizeMap[size];

  // Allow override for contexts where auth may not resolve yet (e.g. login screen)
  const logoUrl = staticLogoUrl !== undefined ? staticLogoUrl : platformSettings.logoUrl;
  const name = staticName !== undefined ? staticName : platformSettings.name;

  return (
    <div className={`flex items-center gap-2.5 select-none ${className}`}>
      {logoUrl ? (
        <img
          src={logoUrl}
          alt={name}
          style={{ width: px, height: px, objectFit: 'contain' }}
        />
      ) : (
        <LogoMark px={px} />
      )}
      <span
        className={`${nameClass} font-medium`}
        style={{ letterSpacing: '0.145em' }}
      >
        {name}
      </span>
    </div>
  );
}

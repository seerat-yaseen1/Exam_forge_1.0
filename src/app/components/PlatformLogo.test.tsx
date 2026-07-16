import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LogoMark } from './PlatformLogo';

describe('LogoMark', () => {
  it('renders an svg with the requested pixel size', () => {
    const { container } = render(<LogoMark px={32} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('width', '32');
    expect(svg).toHaveAttribute('height', '32');
  });

  it('is hidden from assistive tech (decorative mark)', () => {
    const { container } = render(<LogoMark px={20} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders four quadrant rects', () => {
    const { container } = render(<LogoMark px={20} />);
    expect(container.querySelectorAll('rect').length).toBe(4);
  });

  it('defaults to currentColor when no color is given', () => {
    const { container } = render(<LogoMark px={20} />);
    const rect = container.querySelector('rect');
    expect(rect).toHaveAttribute('fill', 'currentColor');
  });

  it('uses a custom color when provided', () => {
    const { container } = render(<LogoMark px={20} color="#ff0000" />);
    const rect = container.querySelector('rect');
    expect(rect).toHaveAttribute('fill', '#ff0000');
  });
});

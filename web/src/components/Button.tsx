import type { ComponentProps } from 'react';
import './Controls.css';

export default function Button({ className = 'button', type, ...props }: ComponentProps<'button'>) {
  return <button {...props} type={type} className={`control-button ${className}`} />;
}

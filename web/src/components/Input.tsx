import type { ComponentProps } from 'react';
import './Controls.css';

export default function Input({ className = '', ...props }: ComponentProps<'input'>) {
  return <input {...props} className={`control-input ${className}`} />;
}

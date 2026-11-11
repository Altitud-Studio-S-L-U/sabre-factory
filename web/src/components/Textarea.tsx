import type { ComponentProps } from 'react';
import './Controls.css';

export default function Textarea({ className = '', ...props }: ComponentProps<'textarea'>) {
  return <textarea {...props} className={`control-textarea ${className}`} />;
}

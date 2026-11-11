import type { ComponentProps } from 'react';
import { Textarea as UiTextarea } from './ui/textarea';
import './Controls.css';

export default function Textarea({ className = '', ...props }: ComponentProps<'textarea'>) {
  return <UiTextarea {...props} className={`control-textarea ${className}`} />;
}

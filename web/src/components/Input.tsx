import type { ComponentProps } from 'react';
import { Input as UiInput } from './ui/input';
import './Controls.css';

export default function Input({ className = '', type, ...props }: ComponentProps<'input'>) {
  if (type === 'checkbox' || type === 'radio')
    return <input {...props} type={type} className={`control-input ${className}`} />;
  return <UiInput {...props} type={type} className={`control-input ${className}`} />;
}

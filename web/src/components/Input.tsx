import { forwardRef, type ComponentProps } from 'react';
import { Input as UiInput } from './ui/input';
import { cn } from '../lib/utils';

const Input = forwardRef<HTMLInputElement, ComponentProps<'input'>>(function Input(
  { className, type, ...props },
  ref,
) {
  if (type === 'checkbox' || type === 'radio')
    return (
      <input ref={ref} {...props} type={type} className={cn('size-4 shrink-0 accent-primary', className)} />
    );
  return <UiInput ref={ref} {...props} type={type} className={className} />;
});

export default Input;

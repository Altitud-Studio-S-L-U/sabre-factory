import type { ComponentProps } from 'react';
import { Button as UiButton } from './ui/button';
import './Controls.css';

export default function Button({ className = 'button', type, ...props }: ComponentProps<'button'>) {
  const classes = className.split(/\s+/);
  if (!classes.includes('button'))
    return <button {...props} type={type} className={`control-button ${className}`} />;
  return (
    <UiButton
      {...props}
      type={type}
      variant={
        classes.includes('primary') ? 'default' : classes.includes('danger') ? 'destructive' : 'secondary'
      }
      size={classes.includes('small') ? 'sm' : 'default'}
      className={`control-button ${className}`}
    />
  );
}

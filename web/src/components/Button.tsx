import { forwardRef, type ComponentProps } from 'react';
import { Button as UiButton, type ButtonProps as UiButtonProps } from './ui/button';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'outline' | 'ghost' | 'link';
export type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

const variants: Record<ButtonVariant, NonNullable<UiButtonProps['variant']>> = {
  primary: 'default',
  secondary: 'secondary',
  danger: 'destructive',
  outline: 'outline',
  ghost: 'ghost',
  link: 'link',
};

/** Words of the retired `.button` vocabulary, still accepted in className. */
const legacy = new Set(['button', 'primary', 'small', 'danger', 'secondary']);

export type ButtonProps = ComponentProps<'button'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
};

/**
 * The console button. `variant` and `size` select the style; a className written in the
 * retired vocabulary ("button primary small") is translated so older call sites keep
 * their look while they migrate.
 */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className = '', variant, size, type, ...props },
  ref,
) {
  const words = className.split(/\s+/).filter(Boolean);
  // A className without the vocabulary and no variant asks for an unstyled button.
  if (!variant && !size && words.length && !words.includes('button'))
    return <button ref={ref} type={type} className={`touch-manipulation ${className}`} {...props} />;
  const chosen: ButtonVariant =
    variant ?? (words.includes('primary') ? 'primary' : words.includes('danger') ? 'danger' : 'secondary');
  const chosenSize: ButtonSize = size ?? (words.includes('small') ? 'sm' : 'default');
  return (
    <UiButton
      ref={ref}
      type={type}
      variant={variants[chosen]}
      size={chosenSize}
      className={['touch-manipulation', ...words.filter((word) => !legacy.has(word))].join(' ')}
      {...props}
    />
  );
});

export default Button;

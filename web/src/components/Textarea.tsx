import { forwardRef, type ComponentProps } from 'react';
import { Textarea as UiTextarea } from './ui/textarea';

const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<'textarea'>>(function Textarea(props, ref) {
  return <UiTextarea ref={ref} {...props} />;
});

export default Textarea;

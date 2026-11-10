import type { SelectHTMLAttributes } from 'react';
import Icon from '../Icon';
import './Select.css';

export default function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="select-control">
      <select {...props} />
      <Icon name="chevron-down" size={16} />
    </span>
  );
}

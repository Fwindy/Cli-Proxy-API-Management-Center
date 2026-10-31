import { useEffect, useRef, type ChangeEvent, type ReactNode } from 'react';
import { IconCheck } from './icons';
import styles from './SelectionCheckbox.module.scss';

interface SelectionCheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (value: boolean) => void;
  label?: ReactNode;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  className?: string;
  labelClassName?: string;
}

export function SelectionCheckbox({
  checked,
  indeterminate = false,
  onChange,
  label,
  ariaLabel,
  title,
  disabled = false,
  className,
  labelClassName,
}: SelectionCheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const rootClassName = [styles.root, disabled ? styles.disabled : '', className]
    .filter(Boolean)
    .join(' ');
  const boxClassName = [
    styles.box,
    checked || indeterminate ? styles.boxChecked : '',
    indeterminate ? styles.boxIndeterminate : '',
  ]
    .filter(Boolean)
    .join(' ');
  const textClassName = [styles.label, labelClassName].filter(Boolean).join(' ');

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(event.target.checked);
  };

  return (
    <label className={rootClassName} title={title}>
      <input
        ref={inputRef}
        className={styles.input}
        type="checkbox"
        checked={checked}
        onChange={handleChange}
        aria-label={ariaLabel}
        aria-checked={indeterminate ? 'mixed' : checked}
        disabled={disabled}
      />
      <span className={boxClassName} aria-hidden="true">
        {checked && !indeterminate ? <IconCheck size={12} /> : null}
      </span>
      {label ? <div className={textClassName}>{label}</div> : null}
    </label>
  );
}

import { useEffect, useState, useRef } from 'react';
import { Pencil } from 'lucide-react';
import "../assets/InputElements.css"

interface NumberInputProps {
  value: number;
  placeholder?: string;
  defaultValue?: number;
  min?: number;
  max?: number;
  className?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}

export function NumberInput({
  value,
  placeholder,
  defaultValue,
  min,
  max,
  className,
  disabled,
  onChange
}: NumberInputProps)  {
  const [text, setText] = useState(String(value ?? ''));

  useEffect(() => {
    setText(String(value ?? ''));
  }, [value]);

  const commitValue = () => {
    const trimmed = text.trim();

    if (trimmed === '') {
      const fallback = defaultValue ?? min ?? 0;
      setText(String(fallback));
      onChange(fallback);
      return;
    }

    let next = Number(trimmed);

    if (Number.isNaN(next)) {
      next = min ?? 0;
    }

    if (min !== undefined && next < min) next = min;
    if (max !== undefined && next > max) next = max;

    setText(String(next));
    onChange(next);
  };

  return (
    <input
      type="number"
      min={min}
      max={max}
      className={className}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commitValue}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
    />
  );
}





interface HiddenTextInputProps {
    value: string;
    className?: string;
    style?: React.CSSProperties;
    inputClassName?: string;
    inputStyle?: React.CSSProperties;
    placeholder?: string;
    disabled?: boolean;
    maxLength?: number;
    onChange: (value: string) => void;
    onCommit?: (value: string) => void;
}

export function HiddenTextInput({
    value,
    className,
    style,
    inputClassName,
    inputStyle,
    placeholder,
    disabled,
    maxLength,
    onChange,
    onCommit
}: HiddenTextInputProps) {
    const [text, setText] = useState(value ?? '');
    const [isHovered, setIsHovered] = useState(false);
    const [isFocused, setIsFocused] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);

    const isEditing = !disabled && (isHovered || isFocused);

    useEffect(() => {
        setText(value ?? '');
    }, [value]);

    const commitValue = () => {
        const next = text.trim();
        onChange(next);
        onCommit?.(next);
    };

    return (
        <p
            className={className}
            style={{
              cursor: disabled ? style?.cursor : 'text',
              display: style?.display ?? 'flex',
              alignItems: style?.alignItems ?? 'center',
              gap: style?.gap ?? '4px',
              ...style
            }}
            onPointerEnter={() => setIsHovered(true)}
            onPointerLeave={() => setIsHovered(false)}
            onClick={() => {
                if (disabled || !isEditing) return;
                inputRef.current?.focus();
            }}
        >
            {isEditing ? (
                <input
                    ref={inputRef}
                    type="text"
                    className={inputClassName}
                    style={inputStyle}
                    value={text}
                    placeholder={placeholder}
                    disabled={disabled}
                    maxLength={maxLength}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => {
                        setIsFocused(false);
                        commitValue();
                    }}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.currentTarget.blur();
                        }

                        if (e.key === 'Escape') {
                            setText(value ?? '');
                            e.currentTarget.blur();
                        }
                    }}
                    onClick={(e) => e.stopPropagation()}
                />
            ) : (
                <>
                    {value || placeholder || ''}
                    {!disabled && <Pencil size={16} style={{opacity: "0.25"}} />}
                </>
            )}
        </p>
    );
}
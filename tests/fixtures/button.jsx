import React from 'react';

export function Button({ variant, style, ...props }) {
  return (
    <button
      type={props.type ?? 'button'}
      {...props}
      style={{
        padding: '7px 12px',
        minHeight: 34,
        borderRadius: 7,
        font: 'inherit',
        fontSize: 13,
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.5 : 1,
        border: variant === 'primary' ? '1px solid #386bdd' : '1px solid var(--dsw-alias-border-l2, #484848)',
        background: variant === 'primary' ? '#386bdd' : 'transparent',
        color: variant === 'primary' ? '#fff' : 'inherit',
        ...style,
      }}
    />
  );
}

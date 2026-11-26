import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { apply } from '../../src/client.jsx';
import { PLUGIN_ID } from '../../src/shared.mjs';

const sections = [];
apply({
  effect: setup => setup(),
  locale: { register: () => () => {} },
  slots: {
    inject(name, setup) {
      if (name !== 'settings.section') throw new Error('仅应注册到 settings.section');
      return setup();
    },
    register(options, component) {
      sections.push({ options, component });
      return () => sections.splice(0);
    },
  },
});

if (sections.length !== 1 || sections[0].options.id !== PLUGIN_ID) {
  throw new Error('设置分类入口注册异常');
}

function Preview() {
  const [active, setActive] = useState(true);
  const { options, component: Section } = sections[0];
  return (
    <div style={{ maxWidth: 1120, margin: '0 auto' }}>
      <header style={{ marginBottom: 20, borderBottom: '1px solid var(--dsw-alias-border-l2)', paddingBottom: 14, display: 'flex', alignItems: 'center', gap: 16 }}>
        <h1 style={{ margin: 0, font: '600 20px system-ui' }}>设置</h1>
        <nav aria-label="设置分类">
          <button
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => setActive(true)}
            style={{
              padding: '7px 14px',
              background: active ? 'var(--dsw-alias-bg-layer-1)' : 'transparent',
              color: 'inherit',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: 7,
              cursor: 'pointer',
            }}
          >
            {options.label()}
          </button>
        </nav>
      </header>
      {active && <Section />}
    </div>
  );
}

createRoot(document.getElementById('app')).render(<Preview />);

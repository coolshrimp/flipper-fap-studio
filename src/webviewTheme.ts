/**
 * Shared visual tokens for every Flipper FAP Studio webview.
 *
 * Individual panels keep their purpose-built layouts, but consume the same
 * charcoal surfaces, Flipper orange accent, typography, status colors, focus
 * treatment, and scrollbar styling.
 */
export const WEBVIEW_THEME = `
  :root {
    color-scheme: dark;
    --fap-accent: #ff8c1a;
    --fap-accent-strong: #fe6d2f;
    --fap-accent-soft: rgba(255, 140, 26, 0.13);
    --fap-accent-hover: rgba(255, 140, 26, 0.20);
    --fap-accent-border: rgba(255, 140, 26, 0.42);
    --fap-bg: #080a0d;
    --fap-surface: #11151b;
    --fap-surface-raised: #171c24;
    --fap-surface-input: #0c1015;
    --fap-line: #333b47;
    --fap-text: #f4f6f8;
    --fap-text-soft: #c6cdd7;
    --fap-muted: #8f99a8;
    --fap-good: #42d392;
    --fap-warn: #ffc857;
    --fap-danger: #ff5b6e;
    --fap-link: #72b7ff;
    --fap-screen: #fe8a2c;
    --fap-ui-font: var(--vscode-font-family, "Segoe UI", sans-serif);
    --fap-code-font: var(--vscode-editor-font-family, "Cascadia Code", Consolas, monospace);
    --fap-radius-sm: 6px;
    --fap-radius: 10px;
    --fap-radius-lg: 14px;
    --fap-shadow: 0 16px 42px rgba(0, 0, 0, 0.28);
  }
  ::selection { background: rgba(255, 140, 26, 0.30); color: var(--fap-text); }
  * { scrollbar-color: #46505e transparent; scrollbar-width: thin; }
  *::-webkit-scrollbar { width: 9px; height: 9px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb { background: #46505e; border: 2px solid transparent; border-radius: 999px; background-clip: padding-box; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible,
  [tabindex]:focus-visible { outline: 2px solid var(--fap-accent); outline-offset: 2px; }
`;

export const WEBVIEW_GRID_BACKGROUND = `
  linear-gradient(rgba(255, 140, 26, .045) 1px, transparent 1px),
  linear-gradient(90deg, rgba(255, 140, 26, .045) 1px, transparent 1px),
  radial-gradient(circle at 76% 8%, rgba(255, 140, 26, .10), transparent 34%),
  var(--fap-bg)
`;

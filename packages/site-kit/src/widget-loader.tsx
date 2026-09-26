/**
 * Loads the CMS widget only for signed-in users (TECHNICAL §10.1). `cms_ui` is a plain hint
 * cookie set at login: visitors download nothing and every page stays identical for them.
 */
const WIDGET_LOADER =
  "if(/(?:^|;\\s*)cms_ui=1(?:;|$)/.test(document.cookie)){var s=document.createElement('script');s.type='module';s.src='/_cms/widget.js';document.head.appendChild(s)}";

/**
 * Platform component, so generated site code never needs `dangerouslySetInnerHTML`.
 * The CSP only runs inline scripts that carry the request nonce.
 */
export function WidgetLoader({ nonce }: { nonce?: string | undefined }) {
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: WIDGET_LOADER }} />;
}

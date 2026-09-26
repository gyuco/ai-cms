import { HtmlValidate, type ConfigData, type Message } from 'html-validate';
import { translate } from './messages.ts';
import { PLUGIN_NAME, plugin } from './rules.ts';

export interface Violation {
  /** Rule id: an `html-validate` rule (e.g. `heading-level`) or one of ours (`ai-cms/...`). */
  rule: string;
  /** Italian explanation, understandable by an editor and by an AI agent. */
  message: string;
  line?: number;
  column?: number;
  /** CSS selector of the offending element, when there is one. */
  selector?: string;
}

export interface ValidationReport {
  errors: Violation[];
  warnings: Violation[];
  /** `true` when there are no errors; warnings never block. */
  ok: boolean;
}

export interface ValidationContext {
  /** Titles of the other pages of the site, to enforce site-wide uniqueness. */
  otherTitles?: string[];
}

/**
 * Presets cover valid HTML5 structure (`standard`), WCAG checks (`a11y`) and whole-document
 * checks (`document`). Style-only rules stay off because the input is React/Next.js output,
 * not hand-written markup: `charSet`, `async=""`, `<meta/>` and ids like `_R_` are all fine.
 */
function config(context: ValidationContext): ConfigData {
  return {
    root: true,
    plugins: [plugin],
    extends: ['html-validate:standard', 'html-validate:a11y', 'html-validate:document'],
    rules: {
      // Our own rules report these with clearer messages and the right severity.
      'no-multiple-main': 'off',
      'empty-title': 'off',
      'unique-landmark': 'off',
      // Multiple <h1> are reported by ai-cms/single-h1; here we only want the level jumps.
      'heading-level': ['error', { allowMultipleH1: true, minInitialRank: 'h1' }],
      // Next.js loads its own same-origin chunks without SRI.
      'require-sri': 'off',
      'deprecated-rule': 'off',
      // A recommendation, not a structural error: <button> defaults to submit.
      'no-implicit-button-type': 'warn',
      // Relaxed ids: React emits ids such as `_R_` or `«r0»`.
      'valid-id': ['error', { relaxed: true }],

      [`${PLUGIN_NAME}/html-lang`]: 'error',
      [`${PLUGIN_NAME}/meta-charset`]: 'error',
      [`${PLUGIN_NAME}/meta-viewport`]: 'error',
      [`${PLUGIN_NAME}/page-title`]: ['error', { otherTitles: context.otherTitles ?? [] }],
      [`${PLUGIN_NAME}/single-main`]: 'error',
      [`${PLUGIN_NAME}/single-h1`]: 'error',
      [`${PLUGIN_NAME}/page-landmarks`]: 'warn',
      [`${PLUGIN_NAME}/meta-description`]: 'warn',
      [`${PLUGIN_NAME}/title-length`]: 'warn',
    },
  };
}

const ERROR = 2;

/** Built-in messages that duplicate one of our rules, which explains the problem better. */
const duplicates: Array<{ rule: string; pattern: RegExp }> = [
  { rule: 'element-required-attributes', pattern: /^<html> is missing required "lang"/ },
  { rule: 'element-required-content', pattern: /^<head> element must have <title>/ },
  { rule: 'element-permitted-occurrences', pattern: /^Element <title> can only appear once/ },
  { rule: 'attribute-allowed-values', pattern: /^Attribute "charset" has invalid value/ },
];

/**
 * With streaming metadata, Next.js renders <title>, <meta> and <link> inside the hidden
 * `MetadataBoundary` div at the top of <body> and React moves them into <head> in the browser.
 */
const streamedMetadata = /^html > body > div(?::nth-child\(\d+\))? > (?:title|meta|link)$/;

function isIgnored(message: Message): boolean {
  if (
    (message.ruleId === 'element-permitted-content' ||
      message.ruleId === 'element-permitted-parent') &&
    streamedMetadata.test(message.selector ?? '')
  ) {
    return true;
  }
  return duplicates.some((d) => d.rule === message.ruleId && d.pattern.test(message.message));
}

function toViolation(message: Message): Violation {
  const violation: Violation = { rule: message.ruleId, message: translate(message) };
  if (message.line > 0) {
    violation.line = message.line;
    violation.column = message.column;
  }
  if (message.selector) violation.selector = message.selector;
  return violation;
}

/** Validates a complete HTML document against the site rules (TECHNICAL §11.1). */
export async function validateDocument(
  html: string,
  context: ValidationContext = {},
): Promise<ValidationReport> {
  const validator = new HtmlValidate(config(context));
  const report = await validator.validateString(html, 'page.html');
  const errors: Violation[] = [];
  const warnings: Violation[] = [];
  for (const message of report.results.flatMap((result) => result.messages)) {
    if (isIgnored(message)) continue;
    (message.severity >= ERROR ? errors : warnings).push(toViolation(message));
  }
  return { errors, warnings, ok: errors.length === 0 };
}

function formatViolation(violation: Violation): string {
  const where: string[] = [];
  if (violation.line !== undefined) {
    where.push(`riga ${String(violation.line)}:${String(violation.column ?? 1)}`);
  }
  if (violation.selector) where.push(violation.selector);
  const location = where.length > 0 ? ` (${where.join(', ')})` : '';
  return `- [${violation.rule}]${location} ${violation.message}`;
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** Compact Italian summary of a report, suitable as tool output for an AI agent. */
export function formatReport(report: ValidationReport): string {
  if (report.errors.length === 0 && report.warnings.length === 0) {
    return 'Regole HTML: nessun problema.';
  }
  const lines = [
    `Regole HTML: ${plural(report.errors.length, 'errore', 'errori')}, ${plural(report.warnings.length, 'avviso', 'avvisi')}.` +
      (report.ok ? ' La pagina è pubblicabile.' : ' Gli errori bloccano la pubblicazione.'),
  ];
  if (report.errors.length > 0) {
    lines.push('Errori:', ...report.errors.map(formatViolation));
  }
  if (report.warnings.length > 0) {
    lines.push('Avvisi:', ...report.warnings.map(formatViolation));
  }
  return lines.join('\n');
}

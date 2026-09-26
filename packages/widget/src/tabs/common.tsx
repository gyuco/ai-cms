import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Si è verificato un errore. Riprova tra poco.';
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/** Loads data when the component mounts and whenever `deps` change. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const run = useCallback(load, deps);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await run();
      if (current !== generation.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (current !== generation.current) return;
      setError(errorMessage(err));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [run]);

  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload]);

  return { data, error, loading, reload };
}

export type Outcome = { kind: 'ok' | 'warning' | 'error'; text: string } | null;

/**
 * Runs one action at a time and keeps its outcome for an aria-live region. The action
 * returns the success message, or an outcome of its own (e.g. a warning).
 */
export function useAction(initial: Outcome = null) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(initial);
  const run = useCallback(async (action: () => Promise<string | Outcome>) => {
    setBusy(true);
    setOutcome(null);
    try {
      const result = await action();
      setOutcome(typeof result === 'string' ? { kind: 'ok', text: result } : result);
      return true;
    } catch (err) {
      setOutcome({ kind: 'error', text: errorMessage(err) });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, outcome, setOutcome, run };
}

/** Always rendered, so screen readers announce every change of the message. */
export function Status({ outcome }: { outcome: Outcome }) {
  return (
    <p
      class={outcome ? `status status-${outcome.kind}` : 'status status-empty'}
      role={outcome?.kind === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      {outcome?.text ?? ''}
    </p>
  );
}

export function LoadState<T>({
  loaded,
  children,
}: {
  loaded: Loaded<T>;
  children: (data: T) => ComponentChildren;
}) {
  if (loaded.error && !loaded.data) {
    return (
      <div class="status status-error" role="alert">
        <p>{loaded.error}</p>
        <button type="button" class="button secondary small" onClick={() => void loaded.reload()}>
          Riprova
        </button>
      </div>
    );
  }
  if (!loaded.data) {
    return (
      <p class="muted" role="status">
        Caricamento…
      </p>
    );
  }
  return <>{children(loaded.data)}</>;
}

export function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: ComponentChildren;
  actions?: ComponentChildren;
}) {
  const id = `cms-section-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section class="section" aria-labelledby={id}>
      <div class="section-head">
        <h3 id={id} class="section-title">
          {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

let fieldCounter = 0;

/** A labelled input; `hint` is linked with aria-describedby. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (props: { id: string; 'aria-describedby'?: string }) => ComponentChildren;
}) {
  const [id] = useState(() => `cms-field-${++fieldCounter}`);
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div class="field">
      <label for={id}>{label}</label>
      {children({ id, 'aria-describedby': hintId })}
      {hint && (
        <p id={hintId} class="hint">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * A button that asks for confirmation in place (no modal): the question and the two
 * choices replace it, with focus on the confirm button.
 */
export function ConfirmButton({
  label,
  question,
  confirmLabel,
  onConfirm,
  disabled,
  ariaLabel,
  small,
}: {
  label: string;
  question: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  small?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);
  useEffect(() => {
    if (asking) confirmRef.current?.focus();
    else if (wasAsking.current) triggerRef.current?.focus();
    wasAsking.current = asking;
  }, [asking]);
  const size = small ? ' small' : '';

  if (!asking) {
    return (
      <button
        ref={triggerRef}
        type="button"
        class={`button secondary${size}`}
        disabled={disabled}
        aria-label={ariaLabel}
        onClick={() => setAsking(true)}
      >
        {label}
      </button>
    );
  }
  return (
    <span
      class="confirm"
      role="group"
      aria-label={question}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        setAsking(false);
      }}
    >
      <span class="confirm-question">{question}</span>
      <button
        ref={confirmRef}
        type="button"
        class={`button danger${size}`}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" class={`button secondary${size}`} onClick={() => setAsking(false)}>
        Annulla
      </button>
    </span>
  );
}
